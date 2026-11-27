import { REDACTED_PLACEHOLDER, isSecretValue } from './secret.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'fatal' | 'silent';

export type LogContext = Record<string, unknown>;

export interface LogEntry {
  readonly timestamp: string;
  readonly level: Exclude<LogLevel, 'silent'>;
  readonly message: string;
  readonly context?: LogContext;
}

export interface ForgeLogger {
  debug(message: string, context?: LogContext): void;
  info(message: string, context?: LogContext): void;
  warn(message: string, context?: LogContext): void;
  error(message: string, context?: LogContext): void;
  fatal(message: string, context?: LogContext): void;
  child(bindings: LogContext): ForgeLogger;
}

export type LogSink = (entry: LogEntry) => void;

export interface ConsoleLoggerOptions {
  readonly level?: LogLevel;
  readonly bindings?: LogContext;
  readonly redactKeys?: readonly string[];
  readonly sink?: LogSink;
}

const LEVEL_WEIGHT: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  fatal: 50,
  silent: 100,
};

const DEFAULT_REDACT_KEYS = [
  'authorization',
  'cookie',
  'set-cookie',
  'password',
  'passwd',
  'pwd',
  'secret',
  'token',
  'accesstoken',
  'refreshtoken',
  'idtoken',
  'apikey',
  'privatekey',
  'clientsecret',
  'creditcard',
];

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[-_]/g, '');
}

function buildRedactionSet(extraKeys?: readonly string[]): ReadonlySet<string> {
  const set = new Set<string>(DEFAULT_REDACT_KEYS.map(normalizeKey));
  if (extraKeys) {
    for (const key of extraKeys) {
      set.add(normalizeKey(key));
    }
  }
  return set;
}

function sanitizeValue(
  value: unknown,
  redactSet: ReadonlySet<string>,
  seen: WeakSet<object>,
): unknown {
  if (value === null || value === undefined) {
    return value;
  }

  if (isSecretValue(value)) {
    return REDACTED_PLACEHOLDER;
  }

  if (typeof value !== 'object') {
    return value;
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (value instanceof Error) {
    const serializedError: Record<string, unknown> = {
      name: value.name,
      message: value.message,
    };
    if ('code' in value && typeof (value as { code?: unknown }).code === 'string') {
      serializedError['code'] = (value as { code: string }).code;
    }
    return serializedError;
  }

  if (seen.has(value)) {
    return '[Circular]';
  }
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeValue(item, redactSet, seen));
  }

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (redactSet.has(normalizeKey(k))) {
      out[k] = REDACTED_PLACEHOLDER;
    } else {
      out[k] = sanitizeValue(v, redactSet, seen);
    }
  }
  return out;
}

interface MinimalConsole {
  log?(message: string): void;
  warn?(message: string): void;
  error?(message: string): void;
}

function defaultConsoleSink(entry: LogEntry): void {
  const line = JSON.stringify(entry);
  const stdConsole = (globalThis as { console?: MinimalConsole }).console;
  if (!stdConsole) {
    return;
  }
  if (entry.level === 'error' || entry.level === 'fatal') {
    stdConsole.error?.(line);
  } else if (entry.level === 'warn') {
    stdConsole.warn?.(line);
  } else {
    stdConsole.log?.(line);
  }
}

export function createConsoleLogger(options: ConsoleLoggerOptions = {}): ForgeLogger {
  const minWeight = LEVEL_WEIGHT[options.level ?? 'info'];
  const sink = options.sink ?? defaultConsoleSink;
  const redactSet = buildRedactionSet(options.redactKeys);
  const baseBindings: LogContext = options.bindings ? { ...options.bindings } : {};

  function emit(level: Exclude<LogLevel, 'silent'>, message: string, context?: LogContext): void {
    if (LEVEL_WEIGHT[level] < minWeight) {
      return;
    }

    const merged: LogContext = { ...baseBindings, ...context };
    const hasContext = Object.keys(merged).length > 0;
    const sanitizedContext = hasContext
      ? (sanitizeValue(merged, redactSet, new WeakSet<object>()) as LogContext)
      : undefined;

    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      message,
      ...(sanitizedContext !== undefined ? { context: sanitizedContext } : {}),
    };

    sink(entry);
  }

  const logger: ForgeLogger = {
    debug: (message, context) => emit('debug', message, context),
    info: (message, context) => emit('info', message, context),
    warn: (message, context) => emit('warn', message, context),
    error: (message, context) => emit('error', message, context),
    fatal: (message, context) => emit('fatal', message, context),
    child(childBindings: LogContext): ForgeLogger {
      const nextOptions: ConsoleLoggerOptions = {
        level: options.level ?? 'info',
        bindings: { ...baseBindings, ...childBindings },
        sink,
        ...(options.redactKeys !== undefined ? { redactKeys: options.redactKeys } : {}),
      };
      return createConsoleLogger(nextOptions);
    },
  };

  return logger;
}

export function createNoopLogger(): ForgeLogger {
  const noop = (): void => {
    // intentionally silent
  };
  const logger: ForgeLogger = {
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    fatal: noop,
    child: () => logger,
  };
  return logger;
}
