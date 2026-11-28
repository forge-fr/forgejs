import { REDACTED_PLACEHOLDER, isSecretValue, type LogContext } from '@forge-fr/core';

export const DEFAULT_REDACT_KEYS: readonly string[] = Object.freeze([
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
  'ssn',
  'cvv',
  'x-api-key',
  'x-auth-token',
  'bearer',
  'sessionid',
  'csrftoken',
  'connectionstring',
  'databaseurl',
]);

export const DEFAULT_PINO_REDACT_PATHS: readonly string[] = Object.freeze([
  'password',
  'passwd',
  'secret',
  'token',
  'accessToken',
  'refreshToken',
  'idToken',
  'apiKey',
  'api_key',
  'privateKey',
  'clientSecret',
  'authorization',
  'cookie',
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-api-key"]',
  'res.headers["set-cookie"]',
  '*.password',
  '*.secret',
  '*.token',
  '*.apiKey',
  '*.api_key',
  '*.authorization',
  '*.cookie',
]);

const FORBIDDEN_OBJECT_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const MAX_SANITIZE_DEPTH = 32;

const CREDENTIALED_URL_REGEX =
  /\b(postgres|postgresql|mysql|mariadb|mongodb(?:\+srv)?|redis|rediss|amqp|amqps|https?):\/\/([^:/@\s]+):([^@\s]+)@/gi;
const INLINE_AUTH_SCHEME_REGEX = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{6,}/gi;

export type CompiledRedactPath = readonly string[];

export function normalizeRedactKey(key: string): string {
  return key.toLowerCase().replace(/[-_]/g, '');
}

export function buildRedactionSet(extraKeys?: readonly string[]): ReadonlySet<string> {
  const set = new Set<string>(DEFAULT_REDACT_KEYS.map(normalizeRedactKey));
  if (extraKeys) {
    for (const key of extraKeys) {
      set.add(normalizeRedactKey(key));
    }
  }
  return set;
}

/**
 * Parses a dot/bracket redaction path such as `user.profile.ssn`,
 * `req.headers["x-api-key"]`, or `*.credentials.*` into normalized path segments.
 */
export function parseRedactPath(rawPath: string): CompiledRedactPath {
  const trimmed = rawPath.trim();
  if (trimmed.length === 0) {
    return [];
  }

  const segments: string[] = [];
  const tokenRegex = /\[(?:"([^"]+)"|'([^']+)'|([^\]]+))\]|([^.[\]]+)/g;
  let match: RegExpExecArray | null;
  while ((match = tokenRegex.exec(trimmed)) !== null) {
    const seg = match[1] ?? match[2] ?? match[3] ?? match[4] ?? '';
    const cleaned = seg.trim();
    if (cleaned.length > 0) {
      segments.push(cleaned === '*' ? '*' : cleaned.toLowerCase());
    }
  }
  return segments;
}

export function compileRedactPaths(
  paths?: readonly string[],
): readonly CompiledRedactPath[] {
  if (!paths || paths.length === 0) {
    return [];
  }
  const compiled: CompiledRedactPath[] = [];
  for (const p of paths) {
    const parsed = parseRedactPath(p);
    if (parsed.length > 0) {
      compiled.push(parsed);
    }
  }
  return compiled;
}

export function matchesRedactPath(
  currentPath: readonly string[],
  compiledPaths: readonly CompiledRedactPath[],
): boolean {
  if (compiledPaths.length === 0 || currentPath.length === 0) {
    return false;
  }

  for (let i = 0; i < compiledPaths.length; i += 1) {
    const pattern = compiledPaths[i]!;
    if (pattern.length !== currentPath.length) {
      continue;
    }
    let matched = true;
    for (let j = 0; j < pattern.length; j += 1) {
      const pSeg = pattern[j]!;
      const cSeg = currentPath[j]!;
      if (pSeg !== '*' && pSeg !== cSeg) {
        matched = false;
        break;
      }
    }
    if (matched) {
      return true;
    }
  }
  return false;
}

export function redactInlineSecrets(input: string): string {
  return input
    .replace(CREDENTIALED_URL_REGEX, `$1://$2:${REDACTED_PLACEHOLDER}@`)
    .replace(INLINE_AUTH_SCHEME_REGEX, `$1 ${REDACTED_PLACEHOLDER}`);
}

export function sanitizeLogMessage(message: string, preventLogInjection = true): string {
  const redacted = redactInlineSecrets(message);
  if (!preventLogInjection) {
    return redacted;
  }
  return redacted
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
    .replace(/\0/g, '\\0')
    .replace(/[\x01-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
}

export interface SanitizeContextOptions {
  readonly redactKeys?: readonly string[];
  readonly redactSet?: ReadonlySet<string>;
  /** Dot/bracket/wildcard paths to redact (e.g. `user.email`, `req.headers["x-custom-secret"]`, `items.*.token`). */
  readonly redactPaths?: readonly string[];
  /** Precompiled dot-paths for hot-path reuse. */
  readonly compiledRedactPaths?: readonly CompiledRedactPath[];
  readonly includeStack?: boolean;
  readonly maxDepth?: number;
}

function sanitizeValueInternal(
  value: unknown,
  redactSet: ReadonlySet<string>,
  compiledPaths: readonly CompiledRedactPath[],
  currentPath: string[],
  includeStack: boolean,
  seen: WeakSet<object>,
  depth: number,
  maxDepth: number,
): unknown {
  if (value === null || value === undefined) {
    return value;
  }

  if (isSecretValue(value)) {
    return REDACTED_PLACEHOLDER;
  }

  if (typeof value === 'string') {
    return redactInlineSecrets(value);
  }

  if (typeof value === 'bigint') {
    return value.toString();
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
      message: redactInlineSecrets(value.message),
    };
    const maybeRecord = value as unknown as Record<string, unknown>;
    if (typeof maybeRecord['code'] === 'string') {
      serializedError['code'] = maybeRecord['code'];
    }
    if (typeof maybeRecord['statusCode'] === 'number') {
      serializedError['statusCode'] = maybeRecord['statusCode'];
    }
    if (includeStack && typeof value.stack === 'string') {
      serializedError['stack'] = redactInlineSecrets(value.stack);
    }
    return serializedError;
  }

  if (seen.has(value)) {
    return '[Circular]';
  }

  if (depth >= maxDepth) {
    return '[MaxDepthExceeded]';
  }

  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((item, idx) => {
      currentPath.push(String(idx));
      const res =
        compiledPaths.length > 0 && matchesRedactPath(currentPath, compiledPaths)
          ? REDACTED_PLACEHOLDER
          : sanitizeValueInternal(
              item,
              redactSet,
              compiledPaths,
              currentPath,
              includeStack,
              seen,
              depth + 1,
              maxDepth,
            );
      currentPath.pop();
      return res;
    });
  }

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_OBJECT_KEYS.has(k)) {
      continue;
    }
    if (redactSet.has(normalizeRedactKey(k))) {
      out[k] = REDACTED_PLACEHOLDER;
      continue;
    }

    if (compiledPaths.length > 0) {
      currentPath.push(k.toLowerCase());
      if (matchesRedactPath(currentPath, compiledPaths)) {
        out[k] = REDACTED_PLACEHOLDER;
      } else {
        out[k] = sanitizeValueInternal(
          v,
          redactSet,
          compiledPaths,
          currentPath,
          includeStack,
          seen,
          depth + 1,
          maxDepth,
        );
      }
      currentPath.pop();
    } else {
      out[k] = sanitizeValueInternal(
        v,
        redactSet,
        compiledPaths,
        currentPath,
        includeStack,
        seen,
        depth + 1,
        maxDepth,
      );
    }
  }
  return out;
}

export function sanitizeLogContext(
  context: LogContext,
  options: SanitizeContextOptions = {},
): LogContext {
  const redactSet = options.redactSet ?? buildRedactionSet(options.redactKeys);
  const compiledPaths = options.compiledRedactPaths ?? compileRedactPaths(options.redactPaths);
  const includeStack = options.includeStack ?? false;
  const maxDepth = options.maxDepth ?? MAX_SANITIZE_DEPTH;
  return sanitizeValueInternal(
    context,
    redactSet,
    compiledPaths,
    [],
    includeStack,
    new WeakSet<object>(),
    0,
    maxDepth,
  ) as LogContext;
}
