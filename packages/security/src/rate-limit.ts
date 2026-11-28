import { ConfigurationError } from '@forge-fr/core';
import type { ForgeContext, ForgeMiddleware } from '@forge-fr/http';
import { RateLimitExceededError } from './errors.js';

const HEADER_CONTROL_CHARS_RE = /[\r\n\u0000]/;

export type RateLimitAlgorithm = 'fixed-window' | 'sliding-window';

export interface RateLimitConsumeResult {
  readonly allowed: boolean;
  readonly limit: number;
  readonly remaining: number;
  readonly resetAtMs: number;
}

export interface RateLimitStore {
  consume(
    key: string,
    windowMs: number,
    max: number,
  ): RateLimitConsumeResult | Promise<RateLimitConsumeResult>;
}

export interface MemoryRateLimitStoreOptions {
  /** Maximum distinct keys tracked to protect against unbounded memory DoS (default: 10000). */
  readonly maxKeys?: number;
  readonly now?: () => number;
  /** Rate-limiting algorithm (`'fixed-window'` or `'sliding-window'`). Default: `'fixed-window'`. */
  readonly algorithm?: RateLimitAlgorithm;
}

export interface SlidingWindowMemoryRateLimitStoreOptions {
  /** Maximum distinct keys tracked to protect against unbounded memory DoS (default: 10000). */
  readonly maxKeys?: number;
  readonly now?: () => number;
}

interface BucketEntry {
  count: number;
  resetAtMs: number;
}

interface SlidingBucketEntry {
  windowIndex: number;
  currentCount: number;
  previousCount: number;
}

/**
 * In-memory O(1) weighted sliding-window rate-limit store that prevents
 * 2x fixed-window boundary bursts while bounding tracked key cardinality.
 */
export function createSlidingWindowMemoryRateLimitStore(
  options: SlidingWindowMemoryRateLimitStoreOptions = {},
): RateLimitStore {
  const maxKeys = options.maxKeys ?? 10_000;
  const now = options.now ?? (() => Date.now());
  if (!Number.isInteger(maxKeys) || maxKeys < 1) {
    throw new ConfigurationError('RateLimitStore maxKeys must be a positive integer');
  }

  const buckets = new Map<string, SlidingBucketEntry>();

  function pruneExpired(currentWindowIndex: number): void {
    for (const [k, entry] of buckets) {
      if (currentWindowIndex - entry.windowIndex >= 2) {
        buckets.delete(k);
      }
    }
  }

  return {
    consume(key: string, windowMs: number, max: number): RateLimitConsumeResult {
      const currentMs = now();
      const currentWindowIndex = Math.floor(currentMs / windowMs);
      const windowStartMs = currentWindowIndex * windowMs;
      const elapsedInWindow = currentMs - windowStartMs;
      const previousWeight = Math.max(0, 1 - elapsedInWindow / windowMs);

      let entry = buckets.get(key);
      if (entry === undefined) {
        if (buckets.size >= maxKeys) {
          pruneExpired(currentWindowIndex);
          if (buckets.size >= maxKeys) {
            const oldestKey = buckets.keys().next().value;
            if (oldestKey !== undefined) {
              buckets.delete(oldestKey);
            }
          }
        }
        entry = { windowIndex: currentWindowIndex, currentCount: 0, previousCount: 0 };
        buckets.set(key, entry);
      } else if (currentWindowIndex - entry.windowIndex >= 2) {
        entry.windowIndex = currentWindowIndex;
        entry.previousCount = 0;
        entry.currentCount = 0;
      } else if (currentWindowIndex === entry.windowIndex + 1) {
        entry.windowIndex = currentWindowIndex;
        entry.previousCount = entry.currentCount;
        entry.currentCount = 0;
      }

      const weightedCount = entry.previousCount * previousWeight + entry.currentCount;
      const windowEndMs = windowStartMs + windowMs;

      if (weightedCount + 1 > max + 1e-9) {
        let resetAtMs = windowEndMs;
        if (entry.previousCount > 0 && entry.currentCount < max) {
          const allowedPreviousWeight = Math.max(0, (max - 1 - entry.currentCount) / entry.previousCount);
          const targetElapsed = Math.ceil((1 - allowedPreviousWeight) * windowMs);
          resetAtMs = Math.min(windowEndMs, windowStartMs + Math.max(1, targetElapsed));
        }
        return Object.freeze({
          allowed: false,
          limit: max,
          remaining: 0,
          resetAtMs,
        });
      }

      entry.currentCount += 1;
      const updatedWeighted = entry.previousCount * previousWeight + entry.currentCount;
      return Object.freeze({
        allowed: true,
        limit: max,
        remaining: Math.max(0, Math.floor(max - updatedWeighted + 1e-9)),
        resetAtMs: windowEndMs,
      });
    },
  };
}

export function createMemoryRateLimitStore(
  options: MemoryRateLimitStoreOptions = {},
): RateLimitStore {
  if (options.algorithm === 'sliding-window') {
    return createSlidingWindowMemoryRateLimitStore(options);
  }

  const maxKeys = options.maxKeys ?? 10_000;
  const now = options.now ?? (() => Date.now());
  if (!Number.isInteger(maxKeys) || maxKeys < 1) {
    throw new ConfigurationError('RateLimitStore maxKeys must be a positive integer');
  }

  const buckets = new Map<string, BucketEntry>();

  function pruneExpired(currentMs: number): void {
    for (const [k, entry] of buckets) {
      if (entry.resetAtMs <= currentMs) {
        buckets.delete(k);
      }
    }
  }

  return {
    consume(key: string, windowMs: number, max: number): RateLimitConsumeResult {
      const currentMs = now();
      const existing = buckets.get(key);

      if (existing === undefined || existing.resetAtMs <= currentMs) {
        if (buckets.size >= maxKeys) {
          pruneExpired(currentMs);
          if (buckets.size >= maxKeys) {
            const oldestKey = buckets.keys().next().value;
            if (oldestKey !== undefined) {
              buckets.delete(oldestKey);
            }
          }
        }
        const resetAtMs = currentMs + windowMs;
        buckets.set(key, { count: 1, resetAtMs });
        return Object.freeze({
          allowed: true,
          limit: max,
          remaining: Math.max(0, max - 1),
          resetAtMs,
        });
      }

      if (existing.count >= max) {
        return Object.freeze({
          allowed: false,
          limit: max,
          remaining: 0,
          resetAtMs: existing.resetAtMs,
        });
      }

      existing.count += 1;
      return Object.freeze({
        allowed: true,
        limit: max,
        remaining: Math.max(0, max - existing.count),
        resetAtMs: existing.resetAtMs,
      });
    },
  };
}

export interface ClientIpOptions {
  /** Defaults to `false` — ignores client-spoofable forwarding headers. */
  readonly trustProxy?: boolean;
  /** Number of trusted reverse proxies appending to `X-Forwarded-For` (default: 1). */
  readonly trustedProxyHops?: number;
  /**
   * Opt-in flag to read `X-Real-IP` when `trustProxy: true` and `X-Forwarded-For` is absent.
   * Defaults to `false` to prevent spoofed `X-Real-IP` bypasses behind proxies that do not strip it (SEC-03).
   */
  readonly trustRealIpHeader?: boolean;
}

export function extractClientIp(ctx: ForgeContext, options: ClientIpOptions = {}): string {
  const remote = ctx.remoteAddress?.trim() || 'unknown';
  if (options.trustProxy !== true) {
    return remote;
  }

  const hops = options.trustedProxyHops ?? 1;
  const xff = ctx.request.headers.get('x-forwarded-for');
  if (xff !== null && xff.trim().length > 0 && !HEADER_CONTROL_CHARS_RE.test(xff)) {
    const chain = xff
      .split(',')
      .map((part) => part.trim())
      .filter((part) => part.length > 0);
    if (chain.length > 0) {
      // Pick the rightmost untrusted IP accounting for `hops` trusted proxies
      const idx = Math.max(0, chain.length - Math.max(1, hops));
      return chain[idx] ?? remote;
    }
  }

  if (options.trustRealIpHeader === true) {
    const realIp = ctx.request.headers.get('x-real-ip')?.trim();
    if (realIp !== undefined && realIp.length > 0 && !HEADER_CONTROL_CHARS_RE.test(realIp)) {
      return realIp;
    }
  }

  return remote;
}

export interface RateLimitMiddlewareOptions extends ClientIpOptions {
  readonly store?: RateLimitStore;
  /** Maximum requests permitted per window (default: 100). */
  readonly max?: number;
  /** Window duration in milliseconds (default: 60000). */
  readonly windowMs?: number;
  /** Algorithm used by the default memory store (`'fixed-window'` or `'sliding-window'`). */
  readonly algorithm?: RateLimitAlgorithm;
  /** Injectable clock function for deterministic testing and Retry-After calculation. */
  readonly now?: () => number;
  /** Custom rate-limit key extractor (defaults to trusted-proxy-safe client IP). */
  readonly keyGenerator?: (ctx: ForgeContext) => string;
  readonly message?: string;
}

export function createRateLimitMiddleware(
  options: RateLimitMiddlewareOptions = {},
): ForgeMiddleware {
  const max = options.max ?? 100;
  const windowMs = options.windowMs ?? 60_000;
  if (!Number.isInteger(max) || max < 1) {
    throw new ConfigurationError('Rate limit max must be a positive integer');
  }
  if (!Number.isInteger(windowMs) || windowMs < 100) {
    throw new ConfigurationError('Rate limit windowMs must be an integer >= 100');
  }

  const now = options.now ?? (() => Date.now());
  const store =
    options.store ??
    createMemoryRateLimitStore({
      now,
      ...(options.algorithm !== undefined ? { algorithm: options.algorithm } : {}),
    });
  const keyGenerator =
    options.keyGenerator ?? ((ctx: ForgeContext) => extractClientIp(ctx, options));
  const message = options.message ?? 'Too many requests';

  return async (ctx, next) => {
    const key = keyGenerator(ctx);
    const result = await store.consume(key, windowMs, max);
    const retryAfterSeconds = Math.max(1, Math.ceil((result.resetAtMs - now()) / 1000));

    ctx.setHeader('ratelimit-limit', String(result.limit));
    ctx.setHeader('ratelimit-remaining', String(result.remaining));
    ctx.setHeader('ratelimit-reset', String(retryAfterSeconds));

    if (!result.allowed) {
      ctx.setHeader('retry-after', String(retryAfterSeconds));
      throw new RateLimitExceededError(retryAfterSeconds, message);
    }

    return next();
  };
}
