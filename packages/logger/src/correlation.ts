import { normalizeError, type ForgeLogger, type LogContext } from '@forge-fr/core';
import type { ForgeContext, ForgeHttpApp, ForgeMiddleware } from '@forge-fr/http';
import { buildRedactionSet, normalizeRedactKey, sanitizeLogContext } from './redact.js';

const SAFE_CORRELATION_ID_REGEX = /^[A-Za-z0-9._:/-]{1,128}$/;

const correlationIdStore = new WeakMap<ForgeContext, string>();
const requestLoggerStore = new WeakMap<ForgeContext, ForgeLogger>();

export interface CorrelationIdOptions {
  /** Header name to read/write correlation IDs. Default: `x-correlation-id`. */
  readonly headerName?: string;
  /** Whether to trust an incoming client/proxy correlation ID header. Default: `false`. */
  readonly trustIncoming?: boolean;
  /** Whether to fall back to `ctx.requestId` when generating an ID. Default: `true`. */
  readonly useRequestIdFallback?: boolean;
  /** Custom correlation ID generator when not trusting incoming headers or when invalid. */
  readonly generator?: () => string;
}

function defaultGenerateCorrelationId(): string {
  if (typeof globalThis.crypto !== 'undefined' && typeof globalThis.crypto.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }
  return `corr-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function isValidCorrelationId(value: string): boolean {
  return SAFE_CORRELATION_ID_REGEX.test(value);
}

export function resolveCorrelationId(
  ctx: ForgeContext,
  options: CorrelationIdOptions = {},
): string {
  const existing = correlationIdStore.get(ctx);
  if (existing !== undefined) {
    return existing;
  }

  const headerName = (options.headerName ?? 'x-correlation-id').toLowerCase();
  if (options.trustIncoming === true) {
    const incoming = ctx.header(headerName)?.trim();
    if (incoming && isValidCorrelationId(incoming)) {
      return incoming;
    }
  }

  if (options.generator) {
    return options.generator();
  }

  if (options.useRequestIdFallback !== false && isValidCorrelationId(ctx.requestId)) {
    return ctx.requestId;
  }

  return defaultGenerateCorrelationId();
}

export function getCorrelationId(ctx: ForgeContext): string | undefined {
  return correlationIdStore.get(ctx) ?? ctx.getState<string>('correlationId');
}

export function getRequestLogger(ctx: ForgeContext): ForgeLogger | undefined {
  return requestLoggerStore.get(ctx);
}

export function bindCorrelationId(
  ctx: ForgeContext,
  options: CorrelationIdOptions = {},
): string {
  const headerName = (options.headerName ?? 'x-correlation-id').toLowerCase();
  const correlationId = resolveCorrelationId(ctx, options);
  correlationIdStore.set(ctx, correlationId);
  ctx.setState('correlationId', correlationId);
  if (!ctx.committed) {
    ctx.setHeader(headerName, correlationId);
  }
  return correlationId;
}

export function createCorrelationIdMiddleware(
  options: CorrelationIdOptions = {},
): ForgeMiddleware {
  return async (ctx, next) => {
    bindCorrelationId(ctx, options);
    return next();
  };
}

export interface RequestLoggingOptions {
  readonly logger: ForgeLogger;
  /** Paths omitted from request completion logs (e.g. `['/health/live']`). */
  readonly ignorePaths?: readonly string[];
  /** Explicit allowlist of request headers to include; sensitive headers are always excluded. */
  readonly logHeaders?: readonly string[];
  /** Whether to include sanitized query parameters in logs. Default: `false`. */
  readonly includeQuery?: boolean;
  /** Threshold in milliseconds above which 2xx/3xx requests log as `warn` with `slow: true`. */
  readonly slowRequestMs?: number;
  /** Additional header/query keys to redact. */
  readonly redactKeys?: readonly string[];
}

function nowMs(): number {
  if (typeof globalThis.performance !== 'undefined' && typeof globalThis.performance.now === 'function') {
    return globalThis.performance.now();
  }
  return Date.now();
}

function pickSafeHeaders(
  ctx: ForgeContext,
  allowlist: readonly string[] | undefined,
  redactSet: ReadonlySet<string>,
): Record<string, string> | undefined {
  if (!allowlist || allowlist.length === 0) {
    return undefined;
  }
  const collected: Record<string, string> = {};
  let hasAny = false;
  for (const rawName of allowlist) {
    const lower = rawName.toLowerCase();
    if (redactSet.has(normalizeRedactKey(lower))) {
      continue;
    }
    const val = ctx.header(lower);
    if (val !== null) {
      collected[lower] = val;
      hasAny = true;
    }
  }
  return hasAny ? collected : undefined;
}

function emitCompletionLog(
  reqLogger: ForgeLogger,
  ctx: ForgeContext,
  statusCode: number,
  durationMs: number,
  options: RequestLoggingOptions,
  redactSet: ReadonlySet<string>,
  error?: unknown,
): void {
  const roundedDuration = Math.round(durationMs * 100) / 100;
  const isSlow =
    options.slowRequestMs !== undefined && roundedDuration >= options.slowRequestMs;
  const safeHeaders = pickSafeHeaders(ctx, options.logHeaders, redactSet);

  const payload: LogContext = {
    method: ctx.method,
    path: ctx.path,
    statusCode,
    durationMs: roundedDuration,
    ...(isSlow ? { slow: true } : {}),
    ...(safeHeaders !== undefined ? { headers: safeHeaders } : {}),
    ...(options.includeQuery === true && Object.keys(ctx.query).length > 0
      ? { query: sanitizeLogContext({ ...ctx.query }, { redactSet }) }
      : {}),
    ...(error !== undefined ? { err: error } : {}),
  };

  if (statusCode >= 500 || error !== undefined && statusCode >= 500) {
    reqLogger.error('http.request.completed', payload);
  } else if (statusCode >= 400 || isSlow) {
    reqLogger.warn('http.request.completed', payload);
  } else {
    reqLogger.info('http.request.completed', payload);
  }
}

export function createRequestLoggingMiddleware(
  options: RequestLoggingOptions,
): ForgeMiddleware {
  const ignored = new Set(options.ignorePaths ?? []);
  const redactSet = buildRedactionSet(options.redactKeys);

  return async (ctx, next) => {
    const correlationId = getCorrelationId(ctx) ?? ctx.requestId;
    const reqLogger = options.logger.child({
      requestId: ctx.requestId,
      correlationId,
    });
    requestLoggerStore.set(ctx, reqLogger);

    const shouldIgnore = ignored.has(ctx.path);
    const start = nowMs();

    try {
      const response = await next();
      if (!shouldIgnore) {
        emitCompletionLog(
          reqLogger,
          ctx,
          response.status,
          nowMs() - start,
          options,
          redactSet,
        );
      }
      return response;
    } catch (err: unknown) {
      if (!shouldIgnore) {
        const normalized = normalizeError(err);
        emitCompletionLog(
          reqLogger,
          ctx,
          normalized.statusCode,
          nowMs() - start,
          options,
          redactSet,
          err,
        );
      }
      throw err;
    }
  };
}

export interface ObservabilityHooksOptions {
  readonly logger: ForgeLogger;
  readonly correlation?: CorrelationIdOptions;
  readonly requestLogging?: Omit<RequestLoggingOptions, 'logger'>;
}

/**
 * Attaches `onRequest` and `onResponse` HTTP hooks so every request — including
 * unmatched 404/405 routes — receives a correlation ID and structured access log.
 */
export function attachObservabilityHooks(
  app: ForgeHttpApp,
  options: ObservabilityHooksOptions,
): void {
  const ignored = new Set(options.requestLogging?.ignorePaths ?? []);
  const redactSet = buildRedactionSet(options.requestLogging?.redactKeys);
  const logOpts: RequestLoggingOptions = {
    logger: options.logger,
    ...(options.requestLogging ?? {}),
  };

  app.addHook('onRequest', ({ ctx }) => {
    const correlationId = bindCorrelationId(ctx, options.correlation);
    if (!requestLoggerStore.has(ctx)) {
      requestLoggerStore.set(
        ctx,
        options.logger.child({ requestId: ctx.requestId, correlationId }),
      );
    }
  });

  app.addHook('onResponse', ({ ctx, statusCode, durationMs }) => {
    if (ignored.has(ctx.path)) {
      return;
    }
    const reqLogger =
      requestLoggerStore.get(ctx) ??
      options.logger.child({
        requestId: ctx.requestId,
        correlationId: getCorrelationId(ctx) ?? ctx.requestId,
      });
    emitCompletionLog(reqLogger, ctx, statusCode, durationMs, logOpts, redactSet);
  });
}
