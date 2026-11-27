import { CacheError, CacheKeyError } from './errors.js';

const MAX_KEY_LENGTH = 512;
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const UNSAFE_KEY_CHARS_RE = /[\r\n\0]/;

export function validateCacheKey(key: string, label = 'Cache key'): string {
  if (typeof key !== 'string' || key.trim().length === 0) {
    throw new CacheKeyError(`${label} must be a non-empty string`);
  }
  if (key.length > MAX_KEY_LENGTH) {
    throw new CacheKeyError(`${label} exceeds maximum length of ${MAX_KEY_LENGTH} characters`, {
      length: key.length,
    });
  }
  if (UNSAFE_KEY_CHARS_RE.test(key)) {
    throw new CacheKeyError(`${label} must not contain CR, LF, or NUL bytes`);
  }
  return key;
}

export function validatePrefixOrTag(value: string, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new CacheKeyError(`${label} must be a non-empty string`);
  }
  if (value.length > MAX_KEY_LENGTH) {
    throw new CacheKeyError(`${label} exceeds maximum length of ${MAX_KEY_LENGTH} characters`);
  }
  if (UNSAFE_KEY_CHARS_RE.test(value)) {
    throw new CacheKeyError(`${label} must not contain CR, LF, or NUL bytes`);
  }
  return value;
}

export function normalizeTtlMs(ttlMs: number | undefined): number | undefined {
  if (ttlMs === undefined) {
    return undefined;
  }
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
    throw new CacheError('Cache TTL must be a finite positive number in milliseconds', {
      statusCode: 400,
      expose: true,
      details: { ttlMs },
    });
  }
  return Math.trunc(ttlMs);
}

/**
 * Recursively clones plain objects/arrays while dropping prototype-pollution
 * own keys (`__proto__`, `constructor`, `prototype`).
 */
export function sanitizeCacheValue<T>(value: T): T {
  if (value === null || value === undefined || typeof value !== 'object') {
    return value;
  }

  if (value instanceof Date) {
    return new Date(value.getTime()) as T;
  }

  if (value instanceof Uint8Array) {
    return new Uint8Array(value) as T;
  }

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeCacheValue(item)) as T;
  }

  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>)) {
    if (FORBIDDEN_KEYS.has(key)) {
      continue;
    }
    const rawProp = (value as Record<string, unknown>)[key];
    Object.defineProperty(out, key, {
      value: sanitizeCacheValue(rawProp),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return out as T;
}

export function parseSafeJson<T>(raw: string): T {
  const parsed: unknown = JSON.parse(raw, (key, val) => {
    if (FORBIDDEN_KEYS.has(key)) {
      return undefined;
    }
    return val;
  });
  return sanitizeCacheValue(parsed) as T;
}

/**
 * Redacts embedded password credentials from Redis / cache connection URLs
 * without mangling safe host/database components.
 */
export function redactCacheUrl(rawUrl: string): string {
  if (typeof rawUrl !== 'string' || rawUrl.length === 0) {
    return rawUrl;
  }
  return rawUrl.replace(
    /^([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)([^/@#?\s]+:)([^/@#?\s]+)(@)/,
    '$1$2[REDACTED]$4',
  );
}
