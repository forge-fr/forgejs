import { ConfigurationError } from '@forge-fr/core';
import type { ForgeContext, ForgeMiddleware } from '@forge-fr/http';
import { RateLimitExceededError } from './errors.js';

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
}

interface BucketEntry {
  count: number;
  resetAtMs: number;
}

export function createMemoryRateLimitStore(
  options: MemoryRateLimitStoreOptions = {},
): RateLimitStore {
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
  /** Defaults to `false` — ignores client-spoofable X-Forwarded-For headers. */
  readonly trustProxy?: boolean;
  /** Number of trusted reverse proxies appending to X-Forwarded-For (default: 1). */
  readonly trustedProxyHops?: number;
}

export function extractClientIp(ctx: ForgeContext, options: ClientIpOptions = {}): string {
  const remote = ctx.remoteAddress?.trim() || 'unknown';
  if (options.trustProxy !== true) {
    return remote;
  }

  const hops = options.trustedProxyHops ?? 1;
  const xff = ctx.request.headers.get('x-forwarded-for');
  if (xff !== null && xff.trim().length > 0) {
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

  const realIp = ctx.request.headers.get('x-real-ip')?.trim();
  if (realIp !== undefined && realIp.length > 0) {
    return realIp;
  }

  return remote;
}

export interface RateLimitMiddlewareOptions extends ClientIpOptions {
  readonly store?: RateLimitStore;
  /** Maximum requests permitted per window (default: 100). */
  readonly max?: number;
  /** Window duration in milliseconds (default: 60000). */
  readonly windowMs?: number;
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

  const store = options.store ?? createMemoryRateLimitStore();
  const keyGenerator =
    options.keyGenerator ?? ((ctx: ForgeContext) => extractClientIp(ctx, options));
  const message = options.message ?? 'Too many requests';

  return async (ctx, next) => {
    const key = keyGenerator(ctx);
    const result = await store.consume(key, windowMs, max);
    const retryAfterSeconds = Math.max(1, Math.ceil((result.resetAtMs - Date.now()) / 1000));

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
