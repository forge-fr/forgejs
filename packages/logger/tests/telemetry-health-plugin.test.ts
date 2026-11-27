import { secret, type HealthRegistry } from '@forge-fr/core';
import { createHttpApp } from '@forge-fr/http';
import { createPluginTestHarness, createTestClient } from '@forge-fr/testing';
import {
  SpanStatusCode,
  TraceFlags,
  type Context,
  type Meter,
  type MeterProvider,
  type Span,
  type SpanContext,
  type SpanOptions,
  type TextMapGetter,
  type TextMapPropagator,
  type Tracer,
  type TracerProvider,
  context as otelContext,
  trace as otelTrace,
} from '@opentelemetry/api';
import { describe, expect, it } from 'vitest';
import {
  ObservabilityTokens,
  createCorrelationIdMiddleware,
  createMemoryLogSink,
  createObservabilityPlugin,
  createOtelHttpMiddleware,
  createOtelInstrumentation,
  createPinoLogger,
  createRequestLoggingMiddleware,
  registerHealthRoutes,
} from '@forge-fr/logger';

interface RecordedSpan {
  name: string;
  attributes: Record<string, unknown>;
  status?: { code: number; message?: string };
  exceptions: unknown[];
  ended: boolean;
  spanContext: SpanContext;
}

function createFakeTelemetryProviders(): {
  tracerProvider: TracerProvider;
  meterProvider: MeterProvider;
  propagator: TextMapPropagator;
  spans: RecordedSpan[];
  counters: Array<{ name: string; value: number; attributes?: Record<string, unknown> }>;
  histograms: Array<{ name: string; value: number; attributes?: Record<string, unknown> }>;
  upDownCounters: Array<{ name: string; value: number; attributes?: Record<string, unknown> }>;
} {
  const spans: RecordedSpan[] = [];
  const counters: Array<{ name: string; value: number; attributes?: Record<string, unknown> }> = [];
  const histograms: Array<{ name: string; value: number; attributes?: Record<string, unknown> }> =
    [];
  const upDownCounters: Array<{
    name: string;
    value: number;
    attributes?: Record<string, unknown>;
  }> = [];

  let spanSeq = 1;

  function makeSpan(name: string, parentCtx?: Context, options?: SpanOptions): Span {
    const parentSpan = parentCtx ? otelTrace.getSpan(parentCtx) : otelTrace.getActiveSpan();
    const traceId =
      parentSpan?.spanContext().traceId ?? '4bf92f3577b34da6a3ce929d0e0e4736';
    const spanId = (spanSeq++).toString(16).padStart(16, '0');
    const spanContext: SpanContext = {
      traceId,
      spanId,
      traceFlags: TraceFlags.SAMPLED,
    };

    const recorded: RecordedSpan = {
      name,
      attributes: { ...(options?.attributes ?? {}) },
      exceptions: [],
      ended: false,
      spanContext,
    };
    spans.push(recorded);

    const span: Span = {
      spanContext: () => spanContext,
      setAttribute(k, v) {
        recorded.attributes[k] = v;
        return span;
      },
      setAttributes(attrs) {
        Object.assign(recorded.attributes, attrs);
        return span;
      },
      addEvent: () => span,
      addLink: () => span,
      addLinks: () => span,
      setStatus(status) {
        recorded.status = status;
        return span;
      },
      updateName(newName) {
        recorded.name = newName;
        return span;
      },
      end() {
        recorded.ended = true;
      },
      isRecording: () => !recorded.ended,
      recordException(err) {
        recorded.exceptions.push(err);
      },
    };
    return span;
  }

  const tracer: Tracer = {
    startSpan(name: string, options?: SpanOptions, ctx?: Context): Span {
      return makeSpan(name, ctx, options);
    },
    startActiveSpan(name: string, ...args: unknown[]): unknown {
      const fn = args[args.length - 1] as (span: Span) => unknown;
      const options = args.length >= 2 ? (args[0] as SpanOptions) : undefined;
      const ctx = args.length >= 3 ? (args[1] as Context) : otelContext.active();
      const span = makeSpan(name, ctx, options);
      const nextCtx = otelTrace.setSpan(ctx, span);
      return otelContext.with(nextCtx, () => fn(span));
    },
  } as unknown as Tracer;

  const tracerProvider: TracerProvider = {
    getTracer: () => tracer,
  };

  const meter: Meter = {
    createCounter(name: string) {
      return {
        add(value: number, attributes?: Record<string, unknown>) {
          counters.push({ name, value, ...(attributes ? { attributes } : {}) });
        },
      };
    },
    createHistogram(name: string) {
      return {
        record(value: number, attributes?: Record<string, unknown>) {
          histograms.push({ name, value, ...(attributes ? { attributes } : {}) });
        },
      };
    },
    createUpDownCounter(name: string) {
      return {
        add(value: number, attributes?: Record<string, unknown>) {
          upDownCounters.push({ name, value, ...(attributes ? { attributes } : {}) });
        },
      };
    },
  } as unknown as Meter;

  const meterProvider: MeterProvider = {
    getMeter: () => meter,
  };

  // Minimal W3C traceparent extractor for testing distributed trace propagation
  const propagator: TextMapPropagator = {
    inject: () => {},
    fields: () => ['traceparent'],
    extract<Carrier>(ctx: Context, carrier: Carrier, getter: TextMapGetter<Carrier>): Context {
      const raw = getter.get(carrier, 'traceparent');
      const value = Array.isArray(raw) ? raw[0] : raw;
      if (typeof value !== 'string') return ctx;
      const parts = value.split('-');
      if (parts.length === 4 && parts[1] && parts[2]) {
        const remoteCtx: SpanContext = {
          traceId: parts[1],
          spanId: parts[2],
          traceFlags: Number.parseInt(parts[3] ?? '01', 16),
          isRemote: true,
        };
        return otelTrace.setSpanContext(ctx, remoteCtx);
      }
      return ctx;
    },
  };

  return { tracerProvider, meterProvider, propagator, spans, counters, histograms, upDownCounters };
}

describe('@forge-fr/logger — OpenTelemetry, Health Endpoints & Observability Plugin', () => {
  it('propagates W3C traceparent, injects trace_id/span_id into Pino logs, records HTTP spans & metrics, and tracks errors', async () => {
    // Enable async context propagation via a lightweight stack context manager for tests
    const fake = createFakeTelemetryProviders();
    let currentCtx: Context = otelContext.active();
    const runWithContext = <T>(ctx: Context, fn: () => T): T => {
      const prev = currentCtx;
      currentCtx = ctx;
      try {
        return fn();
      } finally {
        currentCtx = prev;
      }
    };

    const instrumentation = createOtelInstrumentation({
      serviceName: 'orders-api',
      serviceVersion: '1.2.3',
      tracerProvider: fake.tracerProvider,
      meterProvider: fake.meterProvider,
      propagator: fake.propagator,
      contextAccessor: {
        active: () => currentCtx,
        with: runWithContext,
      },
    });

    const sink = createMemoryLogSink();
    const logger = createPinoLogger({
      level: 'info',
      destination: sink.stream,
      traceContextProvider: () => instrumentation.getActiveTraceContext(),
    });

    const app = createHttpApp({ logger });
    app.use(createCorrelationIdMiddleware({ trustIncoming: true }));
    app.use(
      createOtelHttpMiddleware({
        instrumentation,
        exposeTraceIdHeader: true,
      }),
    );
    app.use(createRequestLoggingMiddleware({ logger }));

    app.get('/orders/:id', async (ctx) => {
      const result = await instrumentation.withSpan('db.fetchOrder', async () => {
        logger.info('loading order', { orderId: ctx.params['id'] });
        return { id: ctx.params['id'], total: 9900 };
      });
      return ctx.json(result);
    });

    app.get('/fail', () => {
      throw new Error('downstream crash');
    });

    const client = createTestClient(app);

    const incomingTraceId = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const res = await client.get('/orders/ord_42', {
      headers: {
        traceparent: `00-${incomingTraceId}-1111111111111111-01`,
        'x-correlation-id': 'corr-otel-1',
      },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('x-trace-id')).toBe(incomingTraceId);

    const failRes = await client.get('/fail');
    expect(failRes.status).toBe(500);

    // Verify spans recorded and ended cleanly
    expect(fake.spans.length).toBe(3); // HTTP /orders/ord_42 + db.fetchOrder + HTTP /fail
    expect(fake.spans[0]?.spanContext.traceId).toBe(incomingTraceId);
    expect(fake.spans[0]?.ended).toBe(true);
    expect(fake.spans[0]?.attributes['http.response.status_code']).toBe(200);

    expect(fake.spans[1]?.name).toBe('db.fetchOrder');
    expect(fake.spans[1]?.spanContext.traceId).toBe(incomingTraceId);
    expect(fake.spans[1]?.status?.code).toBe(SpanStatusCode.OK);
    expect(fake.spans[1]?.ended).toBe(true);

    expect(fake.spans[2]?.status?.code).toBe(SpanStatusCode.ERROR);
    expect(fake.spans[2]?.ended).toBe(true);

    // Verify Pino log inside active span automatically received trace_id and span_id
    const orderLog = sink.entries().find((e) => e['msg'] === 'loading order');
    expect(orderLog?.['trace_id']).toBe(incomingTraceId);
    expect(orderLog?.['span_id']).toBe(fake.spans[1]?.spanContext.spanId);

    // Verify HTTP metrics recorded and active_requests balanced to 0
    expect(fake.counters.filter((c) => c.name === 'http.server.requests')).toHaveLength(2);
    expect(fake.histograms.filter((h) => h.name === 'http.server.request.duration')).toHaveLength(
      2,
    );
    const activeDelta = fake.upDownCounters
      .filter((u) => u.name === 'http.server.active_requests')
      .reduce((acc, item) => acc + item.value, 0);
    expect(activeDelta).toBe(0);
  });

  it('serves production-safe liveness and readiness health endpoints with timeouts and secret redaction', async () => {
    const app = createHttpApp();
    let dbHealthy = true;
    let hangCheck = false;

    app.kernel.health.register('postgres', async () => {
      if (hangCheck) {
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      if (!dbHealthy) {
        return {
          status: 'unhealthy',
          message: 'Failed auth postgres://root:SuperSecretDB@10.0.1.9:5432/prod',
          details: { password: 'hidden-password', secretToken: secret('tok_123'), host: '10.0.1.9' },
        };
      }
      return { status: 'ok', details: { poolIdle: 5 } };
    });

    registerHealthRoutes(app, {
      timeoutMs: 40,
      authorizeDetails: (ctx) => ctx.header('x-internal-probe') === 'trusted',
    });

    const client = createTestClient(app);

    // Liveness always 200 with Cache-Control: no-store even if DB fails
    dbHealthy = false;
    const liveRes = await client.get('/health/live');
    expect(liveRes.status).toBe(200);
    expect(liveRes.headers.get('cache-control')).toBe('no-store');
    expect(((await liveRes.json()) as { status: string }).status).toBe('ok');

    // Public readiness when unhealthy -> 503 with redacted/omitted details
    const pubReadyRes = await client.get('/health/ready');
    expect(pubReadyRes.status).toBe(503);
    expect(pubReadyRes.headers.get('cache-control')).toBe('no-store');
    const pubBody = (await pubReadyRes.json()) as {
      status: string;
      checks: Record<string, { status: string; message?: string; details?: unknown }>;
    };
    expect(pubBody.status).toBe('unhealthy');
    expect(pubBody.checks['postgres']?.status).toBe('unhealthy');
    expect(pubBody.checks['postgres']?.message).toBeUndefined();
    expect(pubBody.checks['postgres']?.details).toBeUndefined();

    // Authorized internal probe sees details, but secrets & DB passwords are STILL redacted!
    const authReadyRes = await client.get('/health/ready', {
      headers: { 'x-internal-probe': 'trusted' },
    });
    expect(authReadyRes.status).toBe(503);
    const authRaw = await authReadyRes.text();
    expect(authRaw).not.toContain('SuperSecretDB');
    expect(authRaw).not.toContain('hidden-password');
    expect(authRaw).not.toContain('tok_123');
    expect(authRaw).toContain('[REDACTED]');

    // Healthy readiness -> 200
    dbHealthy = true;
    const okReadyRes = await client.get('/health/ready');
    expect(okReadyRes.status).toBe(200);
    expect(((await okReadyRes.json()) as { status: string }).status).toBe('ok');

    // Hung health check -> times out cleanly with 503 instead of stalling
    hangCheck = true;
    const timeoutRes = await client.get('/health/ready');
    expect(timeoutRes.status).toBe(503);
    expect(((await timeoutRes.json()) as { status: string }).status).toBe('unhealthy');
  });

  it('registers observability plugin exports in ForgeJS DI, wires health probe, and flushes logs on shutdown', async () => {
    const sink = createMemoryLogSink();
    const plugin = createObservabilityPlugin({
      logger: {
        name: 'plugin-app',
        level: 'info',
        destination: sink.stream,
      },
      serviceName: 'plugin-app',
    });

    const harness = createPluginTestHarness({ plugin });
    await harness.start();

    const logger = harness.resolveExport(ObservabilityTokens.Logger);
    const telemetry = harness.resolveExport(ObservabilityTokens.Telemetry);
    const corrMw = harness.resolveExport(ObservabilityTokens.CorrelationMiddleware);
    const reqLogMw = harness.resolveExport(ObservabilityTokens.RequestLoggingMiddleware);
    const otelMw = harness.resolveExport(ObservabilityTokens.TelemetryMiddleware);

    expect(typeof logger.info).toBe('function');
    expect(typeof logger.flush).toBe('function');
    expect(typeof telemetry.withSpan).toBe('function');
    expect(typeof corrMw).toBe('function');
    expect(typeof reqLogMw).toBe('function');
    expect(typeof otelMw).toBe('function');

    logger.info('plugin booted', { ok: true });

    const health = await harness.health();
    expect(health.status).toBe('ok');
    expect(health.checks['observability:logger']?.status).toBe('ok');

    await harness.shutdown();
    expect(sink.entries().some((e) => e['msg'] === 'plugin booted')).toBe(true);

    // Ensure HealthRegistry typing compatibility check
    const _registryCheck: HealthRegistry = harness.kernel.health;
    expect(_registryCheck).toBeDefined();
  });
});
