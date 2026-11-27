import { CacheError } from './errors.js';
import {
  normalizeTtlMs,
  sanitizeCacheValue,
  validateCacheKey,
  validatePrefixOrTag,
} from './serialize.js';
import type {
  CacheAdapter,
  CacheSetOptions,
  CacheStats,
  MemoryCacheOptions,
} from './types.js';

interface MemoryEntry {
  value: unknown;
  expiresAt?: number;
  tags: readonly string[];
}

export function createMemoryCacheAdapter(options: MemoryCacheOptions = {}): CacheAdapter {
  const maxEntries = options.maxEntries ?? 1000;
  if (!Number.isInteger(maxEntries) || maxEntries < 1) {
    throw new CacheError('maxEntries must be a positive integer', {
      statusCode: 400,
      expose: true,
    });
  }

  const defaultTtlMs = normalizeTtlMs(options.defaultTtlMs);
  const now = options.now ?? (() => Date.now());

  const store = new Map<string, MemoryEntry>();
  const tagIndex = new Map<string, Set<string>>();
  const inFlight = new Map<string, Promise<unknown>>();

  let hits = 0;
  let misses = 0;
  let sets = 0;
  let deletes = 0;
  let evictions = 0;
  let connected = false;

  function unlinkTags(key: string, entry: MemoryEntry): void {
    for (const tag of entry.tags) {
      const set = tagIndex.get(tag);
      if (set) {
        set.delete(key);
        if (set.size === 0) {
          tagIndex.delete(tag);
        }
      }
    }
  }

  function removeEntry(key: string, isEviction = false): boolean {
    const existing = store.get(key);
    if (!existing) {
      return false;
    }
    store.delete(key);
    unlinkTags(key, existing);
    if (isEviction) {
      evictions += 1;
    }
    return true;
  }

  function purgeIfExpired(key: string): MemoryEntry | undefined {
    const entry = store.get(key);
    if (!entry) {
      return undefined;
    }
    if (entry.expiresAt !== undefined && now() >= entry.expiresAt) {
      removeEntry(key, false);
      return undefined;
    }
    return entry;
  }

  function touchLru(key: string, entry: MemoryEntry): void {
    store.delete(key);
    store.set(key, entry);
  }

  function normalizeTags(tags: readonly string[] | undefined): readonly string[] {
    if (!tags || tags.length === 0) {
      return [];
    }
    const clean = new Set<string>();
    for (const t of tags) {
      clean.add(validatePrefixOrTag(t, 'Cache tag'));
    }
    return Array.from(clean);
  }

  return {
    driver: 'memory',

    async connect(): Promise<void> {
      connected = true;
    },

    async disconnect(): Promise<void> {
      connected = false;
      inFlight.clear();
    },

    async ping(): Promise<boolean> {
      return connected;
    },

    async get<T = unknown>(key: string): Promise<T | undefined> {
      const validKey = validateCacheKey(key);
      const entry = purgeIfExpired(validKey);
      if (!entry) {
        misses += 1;
        return undefined;
      }
      touchLru(validKey, entry);
      hits += 1;
      return sanitizeCacheValue(entry.value) as T;
    },

    async set<T = unknown>(key: string, value: T, setOptions?: CacheSetOptions): Promise<void> {
      const validKey = validateCacheKey(key);
      const ttlMs = normalizeTtlMs(setOptions?.ttlMs) ?? defaultTtlMs;
      const tags = normalizeTags(setOptions?.tags);

      const existing = store.get(validKey);
      if (existing) {
        unlinkTags(validKey, existing);
        store.delete(validKey);
      }

      // Evict expired first if at capacity, then oldest LRU key in O(1)
      if (store.size >= maxEntries) {
        for (const [candidateKey, candidateEntry] of store) {
          if (candidateEntry.expiresAt !== undefined && now() >= candidateEntry.expiresAt) {
            removeEntry(candidateKey, false);
          }
          if (store.size < maxEntries) {
            break;
          }
        }
      }
      while (store.size >= maxEntries) {
        const oldestKey = store.keys().next().value;
        if (oldestKey === undefined) {
          break;
        }
        removeEntry(oldestKey, true);
      }

      const sanitized = sanitizeCacheValue(value);
      const entry: MemoryEntry = {
        value: sanitized,
        tags,
        ...(ttlMs !== undefined ? { expiresAt: now() + ttlMs } : {}),
      };
      store.set(validKey, entry);

      for (const tag of tags) {
        let bucket = tagIndex.get(tag);
        if (!bucket) {
          bucket = new Set<string>();
          tagIndex.set(tag, bucket);
        }
        bucket.add(validKey);
      }

      sets += 1;
    },

    async has(key: string): Promise<boolean> {
      const validKey = validateCacheKey(key);
      const entry = purgeIfExpired(validKey);
      if (!entry) {
        return false;
      }
      touchLru(validKey, entry);
      return true;
    },

    async delete(key: string): Promise<boolean> {
      const validKey = validateCacheKey(key);
      const removed = removeEntry(validKey, false);
      if (removed) {
        deletes += 1;
      }
      return removed;
    },

    async deleteByPrefix(prefix: string): Promise<number> {
      const validPrefix = validatePrefixOrTag(prefix, 'Cache prefix');
      const toDelete: string[] = [];
      for (const [k, entry] of store) {
        if (entry.expiresAt !== undefined && now() >= entry.expiresAt) {
          removeEntry(k, false);
          continue;
        }
        if (k.startsWith(validPrefix)) {
          toDelete.push(k);
        }
      }
      let count = 0;
      for (const k of toDelete) {
        if (removeEntry(k, false)) {
          deletes += 1;
          count += 1;
        }
      }
      return count;
    },

    async invalidateTag(tag: string): Promise<number> {
      const validTag = validatePrefixOrTag(tag, 'Cache tag');
      const keys = tagIndex.get(validTag);
      if (!keys || keys.size === 0) {
        return 0;
      }
      let count = 0;
      for (const k of Array.from(keys)) {
        const entry = store.get(k);
        const expired = entry !== undefined && entry.expiresAt !== undefined && now() >= entry.expiresAt;
        if (removeEntry(k, false) && !expired) {
          deletes += 1;
          count += 1;
        }
      }
      return count;
    },

    async ttl(key: string): Promise<number> {
      const validKey = validateCacheKey(key);
      const entry = purgeIfExpired(validKey);
      if (!entry) {
        return -2;
      }
      if (entry.expiresAt === undefined) {
        return -1;
      }
      return Math.max(0, entry.expiresAt - now());
    },

    async increment(key: string, delta = 1): Promise<number> {
      const validKey = validateCacheKey(key);
      if (!Number.isInteger(delta)) {
        throw new CacheError('Cache increment delta must be an integer', {
          statusCode: 400,
          expose: true,
        });
      }
      const existing = purgeIfExpired(validKey);
      let currentNum = 0;
      if (existing !== undefined) {
        if (typeof existing.value !== 'number' || !Number.isFinite(existing.value)) {
          throw new CacheError(`Cache value at key "${validKey}" is not numeric`, {
            statusCode: 400,
            expose: true,
          });
        }
        currentNum = existing.value;
      }
      const next = currentNum + delta;
      if (existing) {
        existing.value = next;
        touchLru(validKey, existing);
        sets += 1;
      } else {
        await this.set(validKey, next);
      }
      return next;
    },

    async getOrSet<T>(
      key: string,
      loader: () => Promise<T> | T,
      setOptions?: CacheSetOptions,
    ): Promise<T> {
      const validKey = validateCacheKey(key);
      const cached = await this.get<T>(validKey);
      if (cached !== undefined) {
        return cached;
      }

      const pending = inFlight.get(validKey);
      if (pending !== undefined) {
        return (await pending) as T;
      }

      const promise = (async () => {
        const value = await loader();
        const sanitized = sanitizeCacheValue(value);
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
      store.clear();
      tagIndex.clear();
    },

    stats(): CacheStats {
      return {
        hits,
        misses,
        sets,
        deletes,
        evictions,
        size: store.size,
      };
    },
  };
}
