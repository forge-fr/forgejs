import { CacheError } from './errors.js';
import {
  normalizeTtlMs,
  parseSafeJson,
  sanitizeCacheValue,
  validateCacheKey,
  validatePrefixOrTag,
} from './serialize.js';
import type {
  CacheAdapter,
  CacheSetOptions,
  CacheStats,
  RedisCacheOptions,
} from './types.js';

export function createRedisCacheAdapter(options: RedisCacheOptions): CacheAdapter {
  const { client } = options;
  const keyPrefix = options.keyPrefix ?? 'forge:';
  const defaultTtlMs = normalizeTtlMs(options.defaultTtlMs);
  const scanCount = options.scanCount ?? 200;

  if (!Number.isInteger(scanCount) || scanCount < 1) {
    throw new CacheError('scanCount must be a positive integer', {
      statusCode: 400,
      expose: true,
    });
  }

  const inFlight = new Map<string, Promise<unknown>>();
  let hits = 0;
  let misses = 0;
  let sets = 0;
  let deletes = 0;
  let cachedSize = 0;

  function toFullKey(key: string): string {
    return `${keyPrefix}${validateCacheKey(key)}`;
  }

  function toTagKey(tag: string): string {
    return `${keyPrefix}__tag:${validatePrefixOrTag(tag, 'Cache tag')}`;
  }

  async function scanKeys(pattern: string): Promise<string[]> {
    const collected = new Set<string>();
    let cursor = '0';
    do {
      const [nextCursor, keys] = await client.scan(cursor, 'MATCH', pattern, 'COUNT', scanCount);
      for (const k of keys) {
        collected.add(k);
      }
      cursor = String(nextCursor);
    } while (cursor !== '0');
    return Array.from(collected);
  }

  return {
    driver: 'redis',

    async connect(): Promise<void> {
      if (client.status !== 'ready' && client.status !== 'connecting' && client.connect) {
        await client.connect();
      }
    },

    async disconnect(): Promise<void> {
      inFlight.clear();
      await client.quit();
    },

    async ping(): Promise<boolean> {
      try {
        const res = await client.ping();
        return res.toUpperCase() === 'PONG';
      } catch {
        return false;
      }
    },

    async get<T = unknown>(key: string): Promise<T | undefined> {
      const fullKey = toFullKey(key);
      const raw = await client.get(fullKey);
      if (raw === null) {
        misses += 1;
        return undefined;
      }
      hits += 1;
      return parseSafeJson<T>(raw);
    },

    async set<T = unknown>(key: string, value: T, setOptions?: CacheSetOptions): Promise<void> {
      const fullKey = toFullKey(key);
      const ttlMs = normalizeTtlMs(setOptions?.ttlMs) ?? defaultTtlMs;
      const sanitized = sanitizeCacheValue(value);
      const serialized = JSON.stringify(sanitized);

      if (ttlMs !== undefined) {
        await client.set(fullKey, serialized, 'PX', ttlMs);
      } else {
        await client.set(fullKey, serialized);
      }

      if (setOptions?.tags && setOptions.tags.length > 0 && client.sadd) {
        for (const tag of setOptions.tags) {
          await client.sadd(toTagKey(tag), fullKey);
        }
      }

      sets += 1;
      cachedSize += 1;
    },

    async has(key: string): Promise<boolean> {
      const fullKey = toFullKey(key);
      return (await client.exists(fullKey)) > 0;
    },

    async delete(key: string): Promise<boolean> {
      const fullKey = toFullKey(key);
      const removed = await client.del(fullKey);
      if (removed > 0) {
        deletes += removed;
        cachedSize = Math.max(0, cachedSize - removed);
        return true;
      }
      return false;
    },

    async deleteByPrefix(prefix: string): Promise<number> {
      const validPrefix = validatePrefixOrTag(prefix, 'Cache prefix');
      const keys = await scanKeys(`${keyPrefix}${validPrefix}*`);
      if (keys.length === 0) {
        return 0;
      }
      let removedTotal = 0;
      for (let i = 0; i < keys.length; i += scanCount) {
        const chunk = keys.slice(i, i + scanCount);
        removedTotal += await client.del(...chunk);
      }
      deletes += removedTotal;
      cachedSize = Math.max(0, cachedSize - removedTotal);
      return removedTotal;
    },

    async invalidateTag(tag: string): Promise<number> {
      const tagKey = toTagKey(tag);
      if (!client.smembers) {
        throw new CacheError('Configured Redis client does not support SMEMBERS for tag invalidation');
      }
      const members = await client.smembers(tagKey);
      let removed = 0;
      if (members.length > 0) {
        removed = await client.del(...members);
      }
      await client.del(tagKey);
      deletes += removed;
      cachedSize = Math.max(0, cachedSize - removed);
      return removed;
    },

    async ttl(key: string): Promise<number> {
      const fullKey = toFullKey(key);
      return client.pttl(fullKey);
    },

    async increment(key: string, delta = 1): Promise<number> {
      const fullKey = toFullKey(key);
      if (!Number.isInteger(delta)) {
        throw new CacheError('Cache increment delta must be an integer', {
          statusCode: 400,
          expose: true,
        });
      }
      const next = await client.incrby(fullKey, delta);
      sets += 1;
      return next;
    },

    async getOrSet<T>(
      key: string,
      loader: () => Promise<T> | T,
      setOptions?: CacheSetOptions,
    ): Promise<T> {
      const validKey = validateCacheKey(key);
      const existing = await this.get<T>(validKey);
      if (existing !== undefined) {
        return existing;
      }

      const pending = inFlight.get(validKey);
      if (pending !== undefined) {
        return (await pending) as T;
      }

      const promise = (async () => {
        const loaded = await loader();
        const sanitized = sanitizeCacheValue(loaded);
        if (sanitized !== undefined) {
          await this.set(validKey, sanitized, setOptions);
        }
        return sanitized;
      })();

      inFlight.set(validKey, promise);
      try {
        return (await promise) as T;
      } finally {
        inFlight.delete(validKey);
      }
    },

    async clear(): Promise<void> {
      const keys = await scanKeys(`${keyPrefix}*`);
      for (let i = 0; i < keys.length; i += scanCount) {
        const chunk = keys.slice(i, i + scanCount);
        await client.del(...chunk);
      }
      cachedSize = 0;
    },

    stats(): CacheStats {
      return {
        hits,
        misses,
        sets,
        deletes,
        evictions: 0,
        size: cachedSize,
      };
    },
  };
}
