import { createPluginTestHarness } from '@forge-fr/testing';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  CacheKeyError,
  CacheTokens,
  createCachePlugin,
  createMemoryCacheAdapter,
  createRedisCacheAdapter,
  redactCacheUrl,
  type RedisClientLike,
} from '@forge-fr/cache';

function createFakeRedisClient(): {
  client: RedisClientLike;
  store: Map<string, { value: string; expiresAt?: number }>;
  sets: Map<string, Set<string>>;
  commands: string[];
} {
  const store = new Map<string, { value: string; expiresAt?: number }>();
  const sets = new Map<string, Set<string>>();
  const commands: string[] = [];

  function purgeIfExpired(key: string): void {
    const entry = store.get(key);
    if (entry?.expiresAt !== undefined && Date.now() >= entry.expiresAt) {
      store.delete(key);
    }
  }

  const client: RedisClientLike = {
    status: 'ready',
    async connect() {
      commands.push('connect');
    },
    async quit() {
      commands.push('quit');
      return 'OK';
    },
    async ping() {
      commands.push('ping');
      return 'PONG';
    },
    async get(key: string) {
      commands.push(`get:${key}`);
      purgeIfExpired(key);
      return store.get(key)?.value ?? null;
    },
    async set(key: string, value: string, ...args: (string | number)[]) {
      commands.push(`set:${key}`);
      let expiresAt: number | undefined;
      if (args[0] === 'PX' && typeof args[1] === 'number') {
        expiresAt = Date.now() + args[1];
      } else if (args[0] === 'EX' && typeof args[1] === 'number') {
        expiresAt = Date.now() + args[1] * 1000;
      }
      store.set(key, { value, ...(expiresAt !== undefined ? { expiresAt } : {}) });
      return 'OK';
    },
    async del(...keys: string[]) {
      commands.push(`del:${keys.join(',')}`);
      let count = 0;
      for (const k of keys) {
        if (store.delete(k) || sets.delete(k)) {
          count += 1;
        }
      }
      return count;
    },
    async exists(...keys: string[]) {
      let count = 0;
      for (const k of keys) {
        purgeIfExpired(k);
        if (store.has(k)) count += 1;
      }
      return count;
    },
    async pttl(key: string) {
      purgeIfExpired(key);
      const entry = store.get(key);
      if (!entry) return -2;
      if (entry.expiresAt === undefined) return -1;
      return Math.max(0, entry.expiresAt - Date.now());
    },
    async incrby(key: string, delta: number) {
      purgeIfExpired(key);
      const currentRaw = store.get(key)?.value;
      const next = (currentRaw !== undefined ? Number.parseInt(currentRaw, 10) : 0) + delta;
      const existingExp = store.get(key)?.expiresAt;
      store.set(key, {
        value: String(next),
        ...(existingExp !== undefined ? { expiresAt: existingExp } : {}),
      });
      return next;
    },
    async scan(cursor: string | number, _matchKw: 'MATCH', pattern: string, _countKw: 'COUNT', _count: number) {
      commands.push(`scan:${String(cursor)}:${pattern}`);
      const prefix = pattern.endsWith('*') ? pattern.slice(0, -1) : pattern;
      const matched = Array.from(store.keys()).filter((k) => k.startsWith(prefix));
      return ['0', matched];
    },
    async sadd(key: string, ...members: string[]) {
      let s = sets.get(key);
      if (!s) {
        s = new Set<string>();
        sets.set(key, s);
      }
      let added = 0;
      for (const m of members) {
        if (!s.has(m)) {
          s.add(m);
          added += 1;
        }
      }
      return added;
    },
    async smembers(key: string) {
      return Array.from(sets.get(key) ?? []);
    },
  };

  return { client, store, sets, commands };
}

describe('@forge-fr/cache — LRU Memory, Redis Adapter & Security Controls', () => {
  it('enforces O(1) LRU eviction, TTL expiration, increment, prefix delete, and tag invalidation', async () => {
    let fakeNow = 1_000_000;
    const cache = createMemoryCacheAdapter({
      maxEntries: 2,
      now: () => fakeNow,
    });
    await cache.connect();

    await cache.set('user:1', { name: 'Alice' }, { ttlMs: 500, tags: ['team:a'] });
    await cache.set('user:2', { name: 'Bob' }, { tags: ['team:a'] });

    // Touch user:1 so user:2 becomes least-recently-used
    expect(await cache.get('user:1')).toEqual({ name: 'Alice' });
    await cache.set('user:3', { name: 'Carol' }, { tags: ['team:b'] });

    expect(await cache.has('user:2')).toBe(false);
    expect(await cache.get('user:1')).toEqual({ name: 'Alice' });
    expect(await cache.ttl('user:1')).toBe(500);

    // Advance clock past TTL of user:1
    fakeNow += 501;
    expect(await cache.get('user:1')).toBeUndefined();
    expect(await cache.ttl('user:1')).toBe(-2);

    // Tag invalidation & prefix deletion
    await cache.set('doc:1', { title: 'Spec' }, { tags: ['org:1'] });
    await cache.set('doc:2', { title: 'Plan' }, { tags: ['org:1', 'org:2'] });
    expect(await cache.invalidateTag('org:1')).toBe(2);
    expect(await cache.has('doc:1')).toBe(false);
    expect(await cache.has('doc:2')).toBe(false);

    expect(await cache.increment('counter:a', 3)).toBe(3);
    expect(await cache.increment('counter:a', 2)).toBe(5);
    expect(await cache.deleteByPrefix('counter:')).toBe(1);
    expect(await cache.has('counter:a')).toBe(false);

    const stats = cache.stats();
    expect(stats.evictions).toBeGreaterThanOrEqual(1);
    await cache.disconnect();
  });

  it('prevents cache stampedes with single-flight getOrSet, strips prototype-pollution keys, and fuzzes cache keys', async () => {
    const cache = createMemoryCacheAdapter();
    await cache.connect();

    let loaderCalls = 0;
    const results = await Promise.all(
      Array.from({ length: 12 }, () =>
        cache.getOrSet('expensive:key', async () => {
          loaderCalls += 1;
          await new Promise((r) => setTimeout(r, 15));
          return { computed: 42 };
        }),
      ),
    );
    expect(loaderCalls).toBe(1);
    expect(results.every((r) => r.computed === 42)).toBe(true);

    // Prototype pollution payload stored from untrusted source must be stripped on read
    const poisoned = JSON.parse('{"ok":true,"__proto__":{"polluted":true},"nested":{"constructor":"bad"}}');
    await cache.set('poison', poisoned);
    const readBack = (await cache.get<Record<string, unknown>>('poison'))!;
    expect(readBack['ok']).toBe(true);
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(readBack, '__proto__')).toBe(false);
    expect(
      Object.prototype.hasOwnProperty.call(readBack['nested'] as Record<string, unknown>, 'constructor'),
    ).toBe(false);

    // Invalid keys rejected fail-closed
    await expect(cache.set('', 'v')).rejects.toThrow(CacheKeyError);
    await expect(cache.set('bad\r\nkey', 'v')).rejects.toThrow(CacheKeyError);
    await expect(cache.set('bad\0key', 'v')).rejects.toThrow(CacheKeyError);

    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1, maxLength: 40 }).filter((s) => !/[\r\n\0]/.test(s) && s.trim().length > 0),
        async (k) => {
          await cache.set(k, { k });
          expect(await cache.get<{ k: string }>(k)).toEqual({ k });
          await cache.delete(k);
        },
      ),
      { numRuns: 50 },
    );

    await cache.disconnect();
  });

  it('wraps RedisClientLike (ioredis) with non-blocking SCAN clearing, TTL, tags, URL redaction, and DI plugin', async () => {
    const fake = createFakeRedisClient();
    const redis = createRedisCacheAdapter({
      client: fake.client,
      keyPrefix: 'forge_test:',
    });
    await redis.connect();

    await redis.set('session:1', { userId: 'u1' }, { ttlMs: 10_000, tags: ['user:u1'] });
    expect(await redis.get('session:1')).toEqual({ userId: 'u1' });
    expect(await redis.ping()).toBe(true);

    // Prefix clear uses non-blocking SCAN (never KEYS)
    const deletedPrefix = await redis.deleteByPrefix('session:');
    expect(deletedPrefix).toBe(1);
    expect(fake.commands.some((c) => c.startsWith('scan:'))).toBe(true);

    // Credential URL redaction
    expect(redactCacheUrl('redis://default:SuperRedisSecret@10.0.0.2:6379/0')).toBe(
      'redis://default:[REDACTED]@10.0.0.2:6379/0',
    );

    // DI Plugin lifecycle & health probe
    const harness = createPluginTestHarness({
      plugin: createCachePlugin({ adapter: redis }),
    });
    await harness.start();
    const injected = harness.resolveExport(CacheTokens.Adapter);
    await injected.set('plugin:k', 'ok');
    expect(await injected.get('plugin:k')).toBe('ok');

    const health = await harness.health();
    expect(health.status).toBe('ok');
    expect(health.checks['cache']?.status).toBe('ok');

    await harness.shutdown();
  });
});
