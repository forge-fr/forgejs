import { QueueValidationError } from './errors.js';

const JOB_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const UNSAFE_CHARS_RE = /[\r\n\0]/;

export function validateJobName(name: string): string {
  if (typeof name !== 'string' || !JOB_NAME_RE.test(name)) {
    throw new QueueValidationError(
      'Job name must match /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/',
      { name },
    );
  }
  return name;
}

export function validateIdempotencyKey(key: string): string {
  if (typeof key !== 'string' || key.trim().length === 0 || key.length > 256 || UNSAFE_CHARS_RE.test(key)) {
    throw new QueueValidationError('Invalid idempotencyKey format');
  }
  return key;
}

/**
 * Deeply clones payloads while stripping prototype-pollution own properties.
 */
export function sanitizePayload<T>(value: T): T {
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
    return value.map((item) => sanitizePayload(item)) as T;
  }

  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>)) {
    if (FORBIDDEN_KEYS.has(key)) {
      continue;
    }
    const rawProp = (value as Record<string, unknown>)[key];
    Object.defineProperty(out, key, {
      value: sanitizePayload(rawProp),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return out as T;
}

export function assertPayloadSizeLimit(payload: unknown, maxBytes: number): void {
  const serialized = JSON.stringify(payload ?? null);
  const byteLength = new TextEncoder().encode(serialized).byteLength;
  if (byteLength > maxBytes) {
    throw new QueueValidationError(
      `Job payload size (${byteLength} bytes) exceeds maxPayloadBytes (${maxBytes})`,
      { byteLength, maxPayloadBytes: maxBytes },
    );
  }
}

export function computeBackoffDelayMs(
  policy: {
    readonly type: 'fixed' | 'exponential';
    readonly delayMs: number;
    readonly maxDelayMs?: number;
    readonly jitter?: boolean;
  },
  attemptNumber: number,
): number {
  const base =
    policy.type === 'exponential'
      ? policy.delayMs * Math.pow(2, Math.max(0, attemptNumber - 1))
      : policy.delayMs;
  const capped = policy.maxDelayMs !== undefined ? Math.min(base, policy.maxDelayMs) : base;
  if (policy.jitter) {
    const spread = Math.floor(Math.random() * Math.max(1, capped * 0.25));
    return Math.max(0, capped + spread);
  }
  return Math.max(0, Math.round(capped));
}
