import {
  createToken,
  definePlugin,
  type ForgeLogger,
  type ForgePlugin,
  type LogContext,
  type LogLevel,
} from '@forge-fr/core';
import type { ForgeMiddleware } from '@forge-fr/http';
import {
  CorrelationIdKey,
  RequestLoggerKey,
  attachObservabilityHooks,
  bindCorrelationId,
  createCorrelationIdMiddleware,
  createRequestLoggingMiddleware,
  getCorrelationId,
  getRequestLogger,
  isValidCorrelationId,
  resolveCorrelationId,
  type CorrelationIdOptions,
  type ObservabilityHooksOptions,
  type RequestLoggingOptions,
} from './correlation.js';
import {
  createLivenessHandler,
  createReadinessHandler,
  registerHealthRoutes,
  type HealthEndpointsOptions,
  type SanitizedHealthCheck,
  type SanitizedHealthPayload,
} from './health.js';
import {
  DEFAULT_REDACT_KEYS,
  buildRedactionSet,
  compileRedactPaths,
  matchesRedactPath,
  normalizeRedactKey,
  parseRedactPath,
  redactInlineSecrets,
  sanitizeLogContext,
  sanitizeLogMessage,
  type CompiledRedactPath,
  type SanitizeContextOptions,
} from './redact.js';

const LEVEL_WEIGHT: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  fatal: 50,
  silent: 100,
};

export interface EdgeLogRecord extends Record<string, unknown> {
  readonly level: Exclude<LogLevel, 'silent'>;
  readonly msg: string;
  readonly time?: string;
  readonly name?: string;
}

export type EdgeLogWriter = (record: EdgeLogRecord, serialized: string) => void;

export interface EdgeMemoryLogSink {
  readonly lines: string[];
  readonly writer: EdgeLogWriter;
  entries(): EdgeLogRecord[];
  clear(): void;
}

export function createEdgeMemoryLogSink(): EdgeMemoryLogSink {
  const lines: string[] = [];
  return {
    lines,
    writer(_record, serialized) {
      lines.push(serialized);
    },
    entries() {
      return lines.map((line) => JSON.parse(line) as EdgeLogRecord);
    },
    clear() {
      lines.length = 0;
    },
  };
}

export interface EdgeLoggerOptions {
  readonly name?: string;
  readonly level?: LogLevel;
  readonly bindings?: LogContext;
  readonly redactKeys?: readonly string[];
  readonly redactPaths?: readonly string[];
  readonly includeStack?: boolean;
  readonly preventLogInjection?: boolean;
  readonly timestamp?: boolean;
  readonly writer?: EdgeLogWriter;
}

export interface EdgeForgeLogger extends ForgeLogger {
  level: LogLevel;
  child(bindings: LogContext): EdgeForgeLogger;
  flush(): Promise<void>;
}

interface MinimalConsole {
  log?(msg: string): void;
  warn?(msg: string): void;
  error?(msg: string): void;
}

function defaultEdgeWriter(record: EdgeLogRecord, serialized: string): void {
  const stdConsole = (globalThis as { console?: MinimalConsole }).console;
  if (!stdConsole) {
    return;
  }
  if (record.level === 'error' || record.level === 'fatal') {
    stdConsole.error?.(serialized);
  } else if (record.level === 'warn') {
    stdConsole.warn?.(serialized);
  } else {
    stdConsole.log?.(serialized);
  }
}

/**
 * Lightweight, zero-Pino structured JSON logger designed for Cloudflare Workers,
 * Deno, and Web Fetch edge runtimes (while running identically on Node.js and Bun).
 */
export function createEdgeLogger(options: EdgeLoggerOptions = {}): EdgeForgeLogger {
  const redactSet = buildRedactionSet(options.redactKeys);
  const compiledRedactPaths = compileRedactPaths(options.redactPaths);
  const includeStack = options.includeStack ?? false;
  const preventLogInjection = options.preventLogInjection ?? true;
  const includeTimestamp = options.timestamp !== false;
  const writer = options.writer ?? defaultEdgeWriter;
  let currentLevel: LogLevel = options.level ?? 'info';

  const baseBindings: LogContext = options.bindings
    ? sanitizeLogContext(options.bindings, { redactSet, compiledRedactPaths, includeStack })
    : {};

  function buildLogger(inheritedBindings: LogContext): EdgeForgeLogger {
    function emit(
      level: Exclude<LogLevel, 'silent'>,
      message: string,
      context?: LogContext,
    ): void {
      if (LEVEL_WEIGHT[level] < LEVEL_WEIGHT[currentLevel]) {
        return;
      }

      const safeMsg = sanitizeLogMessage(message, preventLogInjection);
      const safeContext =
        context !== undefined && Object.keys(context).length > 0
          ? sanitizeLogContext(context, { redactSet, compiledRedactPaths, includeStack })
          : undefined;

      const record: EdgeLogRecord = {
        level,
        ...(includeTimestamp ? { time: new Date().toISOString() } : {}),
        ...(options.name !== undefined ? { name: options.name } : {}),
        ...inheritedBindings,
        ...(safeContext ?? {}),
        msg: safeMsg,
      };

      writer(record, JSON.stringify(record));
    }

    return {
      get level(): LogLevel {
        return currentLevel;
      },
      set level(nextLevel: LogLevel) {
        currentLevel = nextLevel;
      },
      debug: (message, context) => emit('debug', message, context),
      info: (message, context) => emit('info', message, context),
      warn: (message, context) => emit('warn', message, context),
      error: (message, context) => emit('error', message, context),
      fatal: (message, context) => emit('fatal', message, context),
      child(childBindings: LogContext): EdgeForgeLogger {
        const safeChild = sanitizeLogContext(childBindings, {
          redactSet,
          compiledRedactPaths,
          includeStack,
        });
        return buildLogger({ ...inheritedBindings, ...safeChild });
      },
      async flush(): Promise<void> {
        // Edge writers emit synchronously
      },
    };
  }

  return buildLogger(baseBindings);
}

export const EdgeObservabilityTokens = Object.freeze({
  Logger: createToken<EdgeForgeLogger>('@forge-fr/logger/edge:Logger'),
  CorrelationMiddleware: createToken<ForgeMiddleware>('@forge-fr/logger/edge:CorrelationMiddleware'),
  RequestLoggingMiddleware: createToken<ForgeMiddleware>(
    '@forge-fr/logger/edge:RequestLoggingMiddleware',
  ),
});

export interface EdgeObservabilityPluginOptions {
  readonly serviceName?: string;
  readonly logger?: EdgeLoggerOptions;
  readonly correlation?: CorrelationIdOptions;
  readonly requestLogging?: Omit<RequestLoggingOptions, 'logger'>;
  readonly registerHealthCheck?: boolean;
}

export function createEdgeObservabilityPlugin(
  options: EdgeObservabilityPluginOptions = {},
): ForgePlugin<undefined, undefined> {
  return definePlugin({
    name: '@forge-fr/logger/edge',
    version: '1.0.0',
    forgeVersion: '^0.1.0 || ^1.0.0-rc.1 || ^1.0.0',
    capabilities: ['di:register', 'health:register'],
    register(ctx) {
      const logger = createEdgeLogger({
        ...(options.serviceName !== undefined ? { name: options.serviceName } : {}),
        ...(options.logger ?? {}),
      });
      const correlationMw = createCorrelationIdMiddleware(options.correlation);
      const requestLoggingMw = createRequestLoggingMiddleware({
        logger,
        ...(options.requestLogging ?? {}),
      });

      ctx.registerProvider(
        { token: EdgeObservabilityTokens.Logger, useValue: logger },
        { export: true },
      );
      ctx.registerProvider(
        { token: EdgeObservabilityTokens.CorrelationMiddleware, useValue: correlationMw },
        { export: true },
      );
      ctx.registerProvider(
        { token: EdgeObservabilityTokens.RequestLoggingMiddleware, useValue: requestLoggingMw },
        { export: true },
      );

      if (options.registerHealthCheck !== false) {
        ctx.registerHealthCheck('observability:edge-logger', () => ({
          status: 'ok',
          details: { level: logger.level },
        }));
      }
    },
  });
}

export {
  CorrelationIdKey,
  DEFAULT_REDACT_KEYS,
  RequestLoggerKey,
  attachObservabilityHooks,
  bindCorrelationId,
  buildRedactionSet,
  compileRedactPaths,
  createCorrelationIdMiddleware,
  createLivenessHandler,
  createReadinessHandler,
  createRequestLoggingMiddleware,
  getCorrelationId,
  getRequestLogger,
  isValidCorrelationId,
  matchesRedactPath,
  normalizeRedactKey,
  parseRedactPath,
  redactInlineSecrets,
  registerHealthRoutes,
  resolveCorrelationId,
  sanitizeLogContext,
  sanitizeLogMessage,
  type CompiledRedactPath,
  type CorrelationIdOptions,
  type HealthEndpointsOptions,
  type ObservabilityHooksOptions,
  type RequestLoggingOptions,
  type SanitizeContextOptions,
  type SanitizedHealthCheck,
  type SanitizedHealthPayload,
};
