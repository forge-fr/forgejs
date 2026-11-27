import crypto from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { ApplicationKernel } from '@forge-fr/core';
import type { ForgeHttpApp } from '@forge-fr/http';
import { createToken } from '@forge-fr/core';
import {
  createOtelInstrumentation,
  type ContextAccessor,
  type OtelInstrumentation,
} from '@forge-fr/logger';
import {
  TraceFlags,
  context as otelContext,
  type Attributes,
  type Context,
  type Meter,
  type MeterProvider,
  type Span,
  type SpanContext,
  type SpanOptions,
  type SpanStatus,
  type Tracer,
  type TracerProvider,
} from '@opentelemetry/api';

export interface RouteMetricSummary {
  readonly method: string;
  readonly path: string;
  readonly count: number;
  readonly errors: number;
  readonly avgDurationMs: number;
  readonly maxDurationMs: number;
}

export interface RecordedSpanSummary {
  readonly traceId: string;
  readonly spanId: string;
  readonly name: string;
  readonly statusCode?: number;
  readonly durationMs: number;
  readonly timestamp: string;
}

export interface DiModuleTopologyItem {
  readonly name: string;
  readonly imports: readonly string[];
  readonly exportsCount: number;
  readonly providersCount: number;
}

export interface ObservabilitySummary {
  readonly serviceName: string;
  readonly activeRequests: number;
  readonly totalRequests: number;
  readonly errorRequests: number;
  readonly avgDurationMs: number;
  readonly faultInjected: boolean;
  readonly routes: readonly RouteMetricSummary[];
  readonly recentSpans: readonly RecordedSpanSummary[];
  readonly diTopology: readonly DiModuleTopologyItem[];
  readonly registeredHttpRoutes: number;
  readonly registeredWsRoutes: readonly string[];
}

export interface ObservabilityService {
  readonly instrumentation: OtelInstrumentation;
  isFaultInjected(): boolean;
  setFaultInjected(next: boolean): boolean;
  recordHttpResponse(method: string, path: string, statusCode: number, durationMs: number): void;
  getSummary(kernel: ApplicationKernel, app: ForgeHttpApp): ObservabilitySummary;
  resetObservability(): void;
}

export const ObservabilityServiceToken = createToken<ObservabilityService>(
  'playground:ObservabilityService',
);

export function createObservabilityService(serviceName = 'forgejs-live-playground'): ObservabilityService {
  const als = new AsyncLocalStorage<Context>();
  const contextAccessor: ContextAccessor = {
    active: () => als.getStore() ?? otelContext.active(),
    with: <T>(ctx: Context, fn: () => T): T => als.run(ctx, fn),
  };

  let activeRequests = 0;
  let totalRequests = 0;
  let errorRequests = 0;
  let totalDurationMs = 0;
  let faultInjected = false;

  const routeMap = new Map<
    string,
    {
      method: string;
      path: string;
      count: number;
      errors: number;
      totalDurationMs: number;
      maxDurationMs: number;
    }
  >();
  const recentSpans: RecordedSpanSummary[] = [];

  const tracerProvider: TracerProvider = {
    getTracer(): Tracer {
      const tracer: Tracer = {
        startSpan(name: string, options?: SpanOptions): Span {
          const startedAt = performance.now();
          const spanContext: SpanContext = {
            traceId: crypto.randomBytes(16).toString('hex'),
            spanId: crypto.randomBytes(8).toString('hex'),
            traceFlags: TraceFlags.SAMPLED,
          };
          const attrs: Record<string, unknown> = { ...(options?.attributes ?? {}) };
          let ended = false;
          let recording = true;

          const span: Span = {
            spanContext: () => spanContext,
            setAttribute(key: string, value: unknown) {
              attrs[key] = value;
              return span;
            },
            setAttributes(attributes: Attributes) {
              Object.assign(attrs, attributes);
              return span;
            },
            addEvent() {
              return span;
            },
            addLink() {
              return span;
            },
            addLinks() {
              return span;
            },
            setStatus(_status: SpanStatus) {
              return span;
            },
            updateName() {
              return span;
            },
            end() {
              if (ended) return;
              ended = true;
              recording = false;
              const durationMs = Math.max(0.1, performance.now() - startedAt);
              const statusCode =
                typeof attrs['http.response.status_code'] === 'number'
                  ? attrs['http.response.status_code']
                  : undefined;
              if (name.includes('/playground-api/')) {
                recentSpans.unshift({
                  traceId: spanContext.traceId,
                  spanId: spanContext.spanId,
                  name,
                  ...(statusCode !== undefined ? { statusCode } : {}),
                  durationMs: Number(durationMs.toFixed(2)),
                  timestamp: new Date().toISOString(),
                });
                if (recentSpans.length > 25) {
                  recentSpans.length = 25;
                }
              }
            },
            isRecording: () => recording,
            recordException() {
              // No-op in lightweight in-memory demo span
            },
          };
          return span;
        },
        startActiveSpan(...args: unknown[]): unknown {
          const name = String(args[0] ?? 'span');
          const maybeFn = args[args.length - 1];
          const span = tracer.startSpan(name);
          if (typeof maybeFn === 'function') {
            try {
              return (maybeFn as (s: Span) => unknown)(span);
            } finally {
              span.end();
            }
          }
          return undefined;
        },
      };
      return tracer;
    },
  };

  const meterProvider: MeterProvider = {
    getMeter(): Meter {
      const meter: Meter = {
        createCounter: () => ({
          add() {},
        }),
        createUpDownCounter: (name: string) => ({
          add(value: number) {
            if (name === 'http.server.active_requests') {
              activeRequests = Math.max(0, activeRequests + value);
            }
          },
        }),
        createHistogram: () => ({
          record() {},
        }),
        createGauge: () => ({
          record() {},
        }),
        createObservableCounter: () => ({ addCallback() {}, removeCallback() {} }),
        createObservableGauge: () => ({ addCallback() {}, removeCallback() {} }),
        createObservableUpDownCounter: () => ({ addCallback() {}, removeCallback() {} }),
        addBatchObservableCallback() {},
        removeBatchObservableCallback() {},
      };
      return meter;
    },
  };

  const instrumentation = createOtelInstrumentation({
    serviceName,
    serviceVersion: '1.0.0-rc.1',
    tracerProvider,
    meterProvider,
    contextAccessor,
  });

  return {
    instrumentation,

    isFaultInjected(): boolean {
      return faultInjected;
    },

    setFaultInjected(next: boolean): boolean {
      faultInjected = next;
      return faultInjected;
    },

    recordHttpResponse(method: string, path: string, statusCode: number, durationMs: number): void {
      if (!path.startsWith('/playground-api')) return;
      totalRequests += 1;
      totalDurationMs += durationMs;
      if (statusCode >= 400) {
        errorRequests += 1;
      }

      const key = `${method.toUpperCase()} ${path}`;
      const existing = routeMap.get(key);
      if (existing) {
        existing.count += 1;
        if (statusCode >= 400) existing.errors += 1;
        existing.totalDurationMs += durationMs;
        existing.maxDurationMs = Math.max(existing.maxDurationMs, durationMs);
      } else {
        routeMap.set(key, {
          method: method.toUpperCase(),
          path,
          count: 1,
          errors: statusCode >= 400 ? 1 : 0,
          totalDurationMs: durationMs,
          maxDurationMs: durationMs,
        });
      }
    },

    getSummary(kernel: ApplicationKernel, app: ForgeHttpApp): ObservabilitySummary {
      const routes: RouteMetricSummary[] = Array.from(routeMap.values())
        .map((item) => ({
          method: item.method,
          path: item.path,
          count: item.count,
          errors: item.errors,
          avgDurationMs: Number((item.totalDurationMs / item.count).toFixed(2)),
          maxDurationMs: Number(item.maxDurationMs.toFixed(2)),
        }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 12);

      const diTopology: DiModuleTopologyItem[] = kernel.modules.getTopologicalOrder().map((mod) => ({
        name: mod.name,
        imports: (mod.imports ?? []).map((dep) => dep.name),
        exportsCount: mod.exports?.length ?? 0,
        providersCount: mod.providers?.length ?? 0,
      }));

      return {
        serviceName,
        activeRequests,
        totalRequests,
        errorRequests,
        avgDurationMs: totalRequests > 0 ? Number((totalDurationMs / totalRequests).toFixed(2)) : 0,
        faultInjected,
        routes,
        recentSpans: recentSpans.slice(0, 15),
        diTopology,
        registeredHttpRoutes: app.routes().filter((r) => r.path.startsWith('/playground-api')).length,
        registeredWsRoutes: app.wsRoutes().map((w) => w.path),
      };
    },

    resetObservability(): void {
      faultInjected = false;
      activeRequests = 0;
      totalRequests = 0;
      errorRequests = 0;
      totalDurationMs = 0;
      routeMap.clear();
      recentSpans.length = 0;
    },
  };
}
