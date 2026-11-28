# Caching & Redis

> Fast in-memory LRU cache, safe SCAN-based Redis caching, duplicate-request protection via getOrSet(), and tag invalidation.

- **Section**: Advanced Features
- **Packages**: @forge-fr/cache
- **Version**: v1.0.0
- **Updated**: 2026-11-27
- **HTML URL**: https://github.com/forge-fr/forgejs/docs/advanced/caching
- **Markdown URL**: https://github.com/forge-fr/forgejs/docs/advanced/caching.md
- **Source**: https://github.com/forge-fr/forgejs/blob/main/docs/infrastructure-and-cli.md

## Prevent duplicate loads & clear cache by tag

If many requests miss the same cache key at the exact same moment, getOrSet() runs your loader function once and shares the result with all waiting callers, protecting your database from traffic spikes.

**File: `src/cache.ts`**

```ts
import assert from 'node:assert/strict';
import { createMemoryCacheAdapter } from '@forge-fr/cache';

const cache = createMemoryCacheAdapter({ maxEntries: 2_000 });
let loads = 0;

const [a, b] = await Promise.all([
  cache.getOrSet('profile:42', async () => {
    loads += 1;
    return { id: '42', tier: 'pro' };
  }, { ttlMs: 60_000, tags: ['user:42'] }),
  cache.getOrSet('profile:42', async () => {
    loads += 1;
    return { id: '42', tier: 'pro' };
  }, { ttlMs: 60_000, tags: ['user:42'] }),
]);

assert.equal(loads, 1);
assert.deepEqual(a, b);
await cache.invalidateTag('user:42');
```

## Safe Redis key scanning

> **NOTE: No Blocking KEYS * Commands**
>
> createRedisCacheAdapter() uses incremental SCAN batches to clear keys by prefix or tag instead of blocking Redis with KEYS *, and pairs cleanly with createCachePlugin() for automatic shutdown.
