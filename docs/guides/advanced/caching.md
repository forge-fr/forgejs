# Caching & Redis

> O(1) LRU memory cache, cursor SCAN-based Redis cache, single-flight getOrSet() stampede protection, and tag/prefix invalidation.

- **Section**: Advanced Features
- **Packages**: @forge-fr/cache
- **Version**: v1.0.0-rc.2
- **Updated**: 2026-11-26
- **HTML URL**: https://github.com/forge-fr/forgejs/docs/advanced/caching
- **Markdown URL**: https://github.com/forge-fr/forgejs/docs/advanced/caching.md
- **Source**: https://github.com/forge-fr/forgejs/blob/main/docs/infrastructure-and-cli.md

## Single-flight caching & tag invalidation

getOrSet() coalesces concurrent cache misses for the same key into a single in-flight loader promise, preventing thundering-herd spikes against upstream databases.

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

## Non-blocking Redis SCAN invalidation

> **NOTE: Zero Blocking KEYS * Calls**
>
> createRedisCacheAdapter() uses incremental cursor SCAN batches for prefix and tag invalidation instead of blocking Redis KEYS * commands, and supports createCachePlugin() for kernel lifecycle wiring.
