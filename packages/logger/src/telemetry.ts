import { normalizeError } from '@forge-fr/core';
import type { ForgeContext, ForgeMiddleware } from '@forge-fr/http';
import {
  SpanKind,
  SpanStatusCode,
  context as otelContext,
  isSpanContextValid,
  metrics as otelMetrics,
  propagation as otelPropagation,
  trace as otelTrace,
  type Attributes,
  type Context,
  type Counter,
  type Histogram,
  type Meter,
  type MeterProvider,
  type Span,
  type SpanOptions,
  type TextMapGetter,
  type TextMapPropagator,
  type Tracer,
  type TracerProvider,
  type UpDownCounter,
} from '@opentelemetry/api';
import { getCorrelationId } from './correlation.js';

export interface ActiveTraceContext {
  readonly trace_id: string;
  readonly span_id: string;
  readonly trace_flags: string;
}

export interface ContextAccessor {
  active(): Context;
  with<T>(ctx: Context, fn: () => T): T;
}

export interface OtelInstrumentationOptions {
  readonly serviceName?: string;
  readonly serviceVersion?: string;
  readonly tracerProvider?: TracerProvider;
  readonly meterProvider?: MeterProvider;
  readonly propagator?: TextMapPropagator;
  readonly contextAccessor?: ContextAccessor;
}

export interface HttpMetricRecord {
  readonly method: string;
  readonly route: string;
  readonly statusCode: number;
  readonly durationMs: number;
}

export interface OtelInstrumentation {
  readonly tracer: Tracer;
  readonly meter: Meter;
  getActiveTraceContext(): ActiveTraceContext | undefined;
  extractHeaders(headers: Headers): Context;
  withSpan<T>(
    name: string,
    fn: (span: Span) => T | Promise<T>,
    options?: SpanOptions,
  ): Promise<T>;
  recordHttpMetrics(record: HttpMetricRecord): void;
  incrementActiveRequests(method: string): void;
  decrementActiveRequests(method: string): void;
  runInContext<T>(ctx: Context, fn: () => T): T;
  getActiveContext(): Context;
}

const HEADERS_GETTER: TextMapGetter<Headers> = {
  keys(carrier: Headers): string[] {
    const out: string[] = [];
    carrier.forEach((_value, key) => {
      out.push(key);
    });
    return out;
  },
  get(carrier: Headers, key: string): string | undefined {
    return carrier.get(key) ?? undefined;
  },
};

function formatTraceContext(span: Span | undefined): ActiveTraceContext | undefined {
  if (!span) {
    return undefined;
  }
  const sc = span.spanContext();
  if (!isSpanContextValid(sc)) {
    return undefined;
  }
  return {
    trace_id: sc.traceId,
    span_id: sc.spanId,
    trace_flags: sc.traceFlags.toString(16).padStart(2, '0'),
  };
}

/**
 * Extracts active OpenTelemetry trace_id, span_id, and trace_flags from the global OTel context.
 */
export function getActiveTraceContext(): ActiveTraceContext | undefined {
  return formatTraceContext(otelTrace.getActiveSpan());
}

function nowMs(): number {
  if (typeof globalThis.performance !== 'undefined' && typeof globalThis.performance.now === 'function') {
    return globalThis.performance.now();
  }
  return Date.now();
}

export function createOtelInstrumentation(
  options: OtelInstrumentationOptions = {},
): OtelInstrumentation {
  const serviceName = options.serviceName ?? '@forge-fr/app';
  const serviceVersion = options.serviceVersion ?? '0.1.0';

  const tracer: Tracer = options.tracerProvider
    ? options.tracerProvider.getTracer(serviceName, serviceVersion)
    : otelTrace.getTracer(serviceName, serviceVersion);

  const meter: Meter = options.meterProvider
    ? options.meterProvider.getMeter(serviceName, serviceVersion)
    : otelMetrics.getMeter(serviceName, serviceVersion);

  const ctxAccessor: ContextAccessor = options.contextAccessor ?? {
    active: () => otelContext.active(),
    with: <T>(ctx: Context, fn: () => T): T => otelContext.with(ctx, fn),
  };

  const requestCounter: Counter = meter.createCounter('http.server.requests', {
    description: 'Total number of HTTP server requests processed',
  });

  const durationHistogram: Histogram = meter.createHistogram('http.server.request.duration', {
    description: 'Duration of HTTP server requests in seconds',
    unit: 's',
  });

  const activeRequestsCounter: UpDownCounter = meter.createUpDownCounter(
    'http.server.active_requests',
    {
      description: 'Number of active in-flight HTTP server requests',
    },
  );

  function getActiveContext(): Context {
    return ctxAccessor.active();
  }

  function runInContext<T>(ctx: Context, fn: () => T): T {
    return ctxAccessor.with(ctx, fn);
  }

  function getActive(): ActiveTraceContext | undefined {
    const activeSpan = otelTrace.getSpan(getActiveContext()) ?? otelTrace.getActiveSpan();
    return formatTraceContext(activeSpan);
  }

  function extractHeaders(headers: Headers): Context {
    const baseCtx = getActiveContext();
    if (options.propagator) {
      return options.propagator.extract(baseCtx, headers, HEADERS_GETTER);
    }
    return otelPropagation.extract(baseCtx, headers, HEADERS_GETTER);
  }

  async function withSpan<T>(
    name: string,
    fn: (span: Span) => T | Promise<T>,
    spanOptions?: SpanOptions,
  ): Promise<T> {
    const parentCtx = getActiveContext();
    const span = tracer.startSpan(name, spanOptions, parentCtx);
    const spanCtx = otelTrace.setSpan(parentCtx, span);
    try {
      const result = await runInContext(spanCtx, () => fn(span));
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (err: unknown) {
      if (err instanceof Error) {
        span.recordException(err);
      }
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: err instanceof Error ? err.message : 'Span execution failed',
      });
      throw err;
    } finally {
      span.end();
    }
  }

  function recordHttpMetrics(record: HttpMetricRecord): void {
    const attributes: Attributes = {
      'http.request.method': record.method,
      'http.route': record.route,
      'http.response.status_code': record.statusCode,
    };
    requestCounter.add(1, attributes);
    durationHistogram.record(record.durationMs / 1000, attributes);
  }

  function incrementActiveRequests(method: string): void {
    activeRequestsCounter.add(1, { 'http.request.method': method });
  }

  function decrementActiveRequests(method: string): void {
    activeRequestsCounter.add(-1, { 'http.request.method': method });
  }

  return {
    tracer,
    meter,
    getActiveTraceContext: getActive,
    extractHeaders,
    withSpan,
    recordHttpMetrics,
    incrementActiveRequests,
    decrementActiveRequests,
    runInContext,
    getActiveContext,
  };
}

export interface OtelHttpMiddlewareOptions {
  readonly instrumentation?: OtelInstrumentation;
  /** Paths excluded from HTTP tracing & metrics (e.g. `['/health/live']`). */
  readonly ignorePaths?: readonly string[];
  /** Whether to expose `x-trace-id` on HTTP responses. Default: `false`. */
  readonly exposeTraceIdHeader?: boolean;
  /** Header name used when `exposeTraceIdHeader` is enabled. Default: `x-trace-id`. */
  readonly traceIdHeaderName?: string;
}

export function createOtelHttpMiddleware(
  options: OtelHttpMiddlewareOptions = {},
): ForgeMiddleware {
  const instrumentation = options.instrumentation ?? createOtelInstrumentation();
  const ignored = new Set(options.ignorePaths ?? []);
  const exposeTraceIdHeader = options.exposeTraceIdHeader ?? false;
  const traceIdHeaderName = (options.traceIdHeaderName ?? 'x-trace-id').toLowerCase();

  return async (ctx: ForgeContext, next) => {
    if (ignored.has(ctx.path)) {
      return next();
    }

    const parentCtx = instrumentation.extractHeaders(ctx.headers);
    const correlationId = getCorrelationId(ctx);
    const routeLabel = ctx.path;
    const spanName = `${ctx.method} ${routeLabel}`;

    const attributes: Attributes = {
      'http.request.method': ctx.method,
      'url.path': ctx.path,
      'forge.request_id': ctx.requestId,
      ...(correlationId !== undefined ? { 'forge.correlation_id': correlationId } : {}),
    };

    const span = instrumentation.tracer.startSpan(
      spanName,
      { kind: SpanKind.SERVER, attributes },
      parentCtx,
    );

    const sc = span.spanContext();
    if (exposeTraceIdHeader && isSpanContextValid(sc) && !ctx.committed) {
      ctx.setHeader(traceIdHeaderName, sc.traceId);
    }

    const activeSpanCtx = otelTrace.setSpan(parentCtx, span);
    const start = nowMs();
    instrumentation.incrementActiveRequests(ctx.method);

    try {
      const response = await instrumentation.runInContext(activeSpanCtx, () => next());
      const durationMs = nowMs() - start;
      span.setAttribute('http.response.status_code', response.status);
      if (response.status >= 500) {
        span.setStatus({ code: SpanStatusCode.ERROR });
      } else {
        span.setStatus({ code: SpanStatusCode.OK });
      }
      instrumentation.recordHttpMetrics({
        method: ctx.method,
        route: routeLabel,
        statusCode: response.status,
        durationMs,
      });
      return response;
    } catch (err: unknown) {
      const durationMs = nowMs() - start;
      const normalized = normalizeError(err);
      span.setAttribute('http.response.status_code', normalized.statusCode);
      if (err instanceof Error) {
        span.recordException(err);
      }
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: normalized.code,
      });
      instrumentation.recordHttpMetrics({
        method: ctx.method,
        route: routeLabel,
        statusCode: normalized.statusCode,
        durationMs,
      });
      throw err;
    } finally {
      instrumentation.decrementActiveRequests(ctx.method);
      span.end();
    }
  };
}
