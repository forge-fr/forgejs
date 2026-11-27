import type { HealthCheckResult, HealthRegistry, HealthReport, HealthStatus } from '@forge-fr/core';
import type { ForgeContext, ForgeHttpApp, ForgeRouteHandler } from '@forge-fr/http';
import { buildRedactionSet, redactInlineSecrets, sanitizeLogContext } from './redact.js';

export interface HealthEndpointsOptions {
  /** Custom HealthRegistry (defaults to `app.kernel.health` in `registerHealthRoutes`). */
  readonly registry?: HealthRegistry;
  /** Liveness route path. Default: `/health/live`. */
  readonly livePath?: string;
  /** Readiness route path. Default: `/health/ready`. */
  readonly readyPath?: string;
  /** Maximum duration in ms to wait for `registry.runAll()`. Default: `5000`. */
  readonly timeoutMs?: number;
  /** Whether `degraded` status returns HTTP 200 (ready) vs 503. Default: `true`. */
  readonly treatDegradedAsReady?: boolean;
  /** Whether to expose sanitized error messages and check details. Default: `false`. */
  readonly exposeDetails?: boolean;
  /** Optional per-request predicate authorizing detailed check output (e.g. internal probe header). */
  readonly authorizeDetails?: (ctx: ForgeContext) => boolean | Promise<boolean>;
  /** Extra redaction keys applied when details are exposed. */
  readonly redactKeys?: readonly string[];
}

export interface SanitizedHealthCheck {
  readonly status: HealthStatus;
  readonly durationMs?: number;
  readonly message?: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

export interface SanitizedHealthPayload {
  readonly status: HealthStatus;
  readonly timestamp: string;
  readonly checks: Readonly<Record<string, SanitizedHealthCheck>>;
}

function runWithTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Health check timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

function formatHealthReport(
  report: HealthReport,
  includeDetails: boolean,
  redactSet: ReadonlySet<string>,
): SanitizedHealthPayload {
  const checks: Record<string, SanitizedHealthCheck> = {};
  for (const [name, entry] of Object.entries(report.checks) as [string, HealthCheckResult][]) {
    if (!includeDetails) {
      checks[name] = {
        status: entry.status,
        ...(entry.durationMs !== undefined ? { durationMs: entry.durationMs } : {}),
      };
    } else {
      checks[name] = {
        status: entry.status,
        ...(entry.durationMs !== undefined ? { durationMs: entry.durationMs } : {}),
        ...(entry.message !== undefined ? { message: redactInlineSecrets(entry.message) } : {}),
        ...(entry.details !== undefined
          ? { details: sanitizeLogContext({ ...entry.details }, { redactSet }) }
          : {}),
      };
    }
  }

  return {
    status: report.status,
    timestamp: report.timestamp,
    checks,
  };
}

/**
 * Lightweight liveness probe handler (`200 OK`, `Cache-Control: no-store`).
 * Intentionally avoids external I/O checks to prevent orchestrator restart storms.
 */
export function createLivenessHandler(): ForgeRouteHandler {
  return (ctx) => {
    ctx.setHeader('cache-control', 'no-store');
    return ctx.json(
      {
        status: 'ok' as const,
        timestamp: new Date().toISOString(),
      },
      { status: 200 },
    );
  };
}

/**
 * Readiness probe handler executing `HealthRegistry.runAll()` with timeout enforcement
 * and production-safe redaction of check messages and details.
 */
export function createReadinessHandler(
  registry: HealthRegistry,
  options: Omit<HealthEndpointsOptions, 'registry' | 'livePath' | 'readyPath'> = {},
): ForgeRouteHandler {
  const timeoutMs = options.timeoutMs ?? 5000;
  const treatDegradedAsReady = options.treatDegradedAsReady ?? true;
  const redactSet = buildRedactionSet(options.redactKeys);

  return async (ctx) => {
    ctx.setHeader('cache-control', 'no-store');

    let includeDetails = options.exposeDetails === true;
    if (!includeDetails && options.authorizeDetails) {
      includeDetails = Boolean(await options.authorizeDetails(ctx));
    }

    try {
      const report = await runWithTimeout(registry.runAll(), timeoutMs);
      const isReady =
        report.status === 'ok' || (treatDegradedAsReady && report.status === 'degraded');
      const payload = formatHealthReport(report, includeDetails, redactSet);
      return ctx.json(payload, { status: isReady ? 200 : 503 });
    } catch {
      return ctx.json(
        {
          status: 'unhealthy' as const,
          timestamp: new Date().toISOString(),
          checks: {},
        },
        { status: 503 },
      );
    }
  };
}

/**
 * Registers production-safe liveness (`/health/live`) and readiness (`/health/ready`)
 * routes directly on a ForgeJS HTTP application.
 */
export function registerHealthRoutes(
  app: ForgeHttpApp,
  options: HealthEndpointsOptions = {},
): void {
  const registry = options.registry ?? app.kernel.health;
  const livePath = options.livePath ?? '/health/live';
  const readyPath = options.readyPath ?? '/health/ready';

  app.get(livePath, createLivenessHandler());
  app.get(readyPath, createReadinessHandler(registry, options));
}
