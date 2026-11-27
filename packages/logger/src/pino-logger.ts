import { REDACTED_PLACEHOLDER, type ForgeLogger, type LogContext, type LogLevel } from '@forge-fr/core';
import {
  pino,
  type DestinationStream,
  type Logger as PinoLogger,
  type LoggerOptions as RawPinoOptions,
} from 'pino';
import {
  DEFAULT_PINO_REDACT_PATHS,
  buildRedactionSet,
  sanitizeLogContext,
  sanitizeLogMessage,
} from './redact.js';
import { getActiveTraceContext, type ActiveTraceContext } from './telemetry.js';

export interface MemoryLogSink {
  readonly stream: DestinationStream;
  readonly lines: string[];
  entries(): Record<string, unknown>[];
  clear(): void;
}

/**
 * Runtime-agnostic in-memory Pino destination stream for deterministic testing on Node.js and Bun runtimes.
 */
export function createMemoryLogSink(): MemoryLogSink {
  const lines: string[] = [];
  const stream: DestinationStream = {
    write(msg: string): void {
      const trimmed = msg.trimEnd();
      if (trimmed.length > 0) {
        lines.push(trimmed);
      }
    },
  };

  return {
    stream,
    lines,
    entries(): Record<string, unknown>[] {
      return lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    },
    clear(): void {
      lines.length = 0;
    },
  };
}

export interface PinoForgeLogger extends ForgeLogger {
  readonly raw: PinoLogger;
  level: LogLevel;
  flush(): Promise<void>;
  child(bindings: LogContext): PinoForgeLogger;
}

export interface PinoLoggerOptions {
  readonly name?: string;
  readonly level?: LogLevel;
  readonly bindings?: LogContext;
  readonly redactKeys?: readonly string[];
  readonly redactPaths?: readonly string[];
  /** Inject active OpenTelemetry `trace_id`/`span_id` into log records. Default: `true`. */
  readonly includeOtelTraceContext?: boolean;
  /** Custom trace context provider (defaults to `@opentelemetry/api` active span). */
  readonly traceContextProvider?: () => ActiveTraceContext | undefined;
  /** Include error stack traces in logs. Default: `false` (production-safe). */
  readonly includeStack?: boolean;
  /** Escape CR/LF/NUL control characters in log messages. Default: `true`. */
  readonly preventLogInjection?: boolean;
  /** Emit ISO-8601 UTC timestamp (`time` field). Default: `true`. */
  readonly timestamp?: boolean;
  /** Include default Pino `pid`/`hostname` base fields. Default: `false`. */
  readonly includeBase?: boolean;
  /** Custom Pino destination stream (defaults to stdout). */
  readonly destination?: DestinationStream;
}

interface InternalWrapConfig {
  readonly redactSet: ReadonlySet<string>;
  readonly includeStack: boolean;
  readonly preventLogInjection: boolean;
}

function wrapPinoInstance(rawLogger: PinoLogger, config: InternalWrapConfig): PinoForgeLogger {
  function emit(
    level: Exclude<LogLevel, 'silent'>,
    message: string,
    context?: LogContext,
  ): void {
    const safeMsg = sanitizeLogMessage(message, config.preventLogInjection);
    if (context !== undefined && Object.keys(context).length > 0) {
      const safeContext = sanitizeLogContext(context, {
        redactSet: config.redactSet,
        includeStack: config.includeStack,
      });
      rawLogger[level](safeContext, safeMsg);
    } else {
      rawLogger[level](safeMsg);
    }
  }

  return {
    raw: rawLogger,
    get level(): LogLevel {
      return rawLogger.level as LogLevel;
    },
    set level(nextLevel: LogLevel) {
      rawLogger.level = nextLevel;
    },
    debug: (message, context) => emit('debug', message, context),
    info: (message, context) => emit('info', message, context),
    warn: (message, context) => emit('warn', message, context),
    error: (message, context) => emit('error', message, context),
    fatal: (message, context) => emit('fatal', message, context),
    child(bindings: LogContext): PinoForgeLogger {
      const safeBindings = sanitizeLogContext(bindings, {
        redactSet: config.redactSet,
        includeStack: config.includeStack,
      });
      return wrapPinoInstance(rawLogger.child(safeBindings), config);
    },
    flush(): Promise<void> {
      return new Promise<void>((resolve, reject) => {
        rawLogger.flush((err?: Error) => {
          if (err) {
            reject(err);
          } else {
            resolve();
          }
        });
      });
    },
  };
}

export function createPinoLogger(options: PinoLoggerOptions = {}): PinoForgeLogger {
  const redactSet = buildRedactionSet(options.redactKeys);
  const includeStack = options.includeStack ?? false;
  const preventLogInjection = options.preventLogInjection ?? true;
  const includeOtelTraceContext = options.includeOtelTraceContext ?? true;
  const traceProvider = options.traceContextProvider ?? getActiveTraceContext;

  const mergedPaths = Array.from(
    new Set([...DEFAULT_PINO_REDACT_PATHS, ...(options.redactPaths ?? [])]),
  );

  const sanitizedBaseBindings = options.bindings
    ? sanitizeLogContext(options.bindings, { redactSet, includeStack })
    : undefined;

  const resolvedBase: Record<string, unknown> = {
    ...(options.name !== undefined ? { name: options.name } : {}),
    ...(sanitizedBaseBindings ?? {}),
  };

  const baseField =
    options.includeBase === true
      ? sanitizedBaseBindings !== undefined
        ? resolvedBase
        : undefined
      : Object.keys(resolvedBase).length > 0
        ? resolvedBase
        : null;

  const pinoOpts: RawPinoOptions = {
    level: options.level ?? 'info',
    timestamp: options.timestamp === false ? false : pino.stdTimeFunctions.isoTime,
    formatters: {
      level(label: string) {
        return { level: label };
      },
    },
    redact: {
      paths: mergedPaths,
      censor: REDACTED_PLACEHOLDER,
    },
    serializers: {
      err(value: unknown): unknown {
        if (value instanceof Error) {
          return sanitizeLogContext({ err: value }, { redactSet, includeStack })['err'];
        }
        return value;
      },
    },
    ...(options.name !== undefined ? { name: options.name } : {}),
    ...(baseField !== undefined ? { base: baseField } : {}),
    ...(includeOtelTraceContext
      ? {
          mixin(): Record<string, unknown> {
            const active = traceProvider();
            if (!active) {
              return {};
            }
            return {
              trace_id: active.trace_id,
              span_id: active.span_id,
              trace_flags: active.trace_flags,
            };
          },
        }
      : {}),
  };

  const rawLogger =
    options.destination !== undefined ? pino(pinoOpts, options.destination) : pino(pinoOpts);

  return wrapPinoInstance(rawLogger, {
    redactSet,
    includeStack,
    preventLogInjection,
  });
}
