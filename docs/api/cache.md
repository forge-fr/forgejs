# @forge-fr/cache

> O(1) LRU in-memory and cursor SCAN-based Redis cache adapters with single-flight getOrSet, tag invalidation, prefix deletion, and CRLF/NUL key validation.

- **Version**: v1.0.0-rc.2
- **Layer**: Infrastructure
- **Category**: infrastructure
- **Tarball**: 13.2 kB (32 files)
- **Internal deps**: @forge-fr/core
- **Runtime deps**: zero runtime dependencies
- **Peer deps**: ioredis >=5 || >=6 (optional)
- **HTML URL**: https://github.com/forge-fr/forgejs/api/cache
- **Markdown URL**: https://github.com/forge-fr/forgejs/api/cache.md

## Installation

```bash
npm install @forge-fr/cache
```

## Plugin Metadata

- **Factory**: `createCachePlugin`
- **Tokens**: `CacheTokens`
- **Health probe**: `cache`
- **Capabilities**: `di:register`, `health:register`

## Runtime & Error Semantics

- **Runtime**: Zero third-party runtime dependencies; optional peer ioredis >=5 || >=6. Redis invalidation uses cursor SCAN (never KEYS).
- **Errors**: Rejects CR/LF/NUL cache keys with CacheKeyError and prevents prototype pollution on deserialization.

## Usage Example

```ts
import { createMemoryCacheAdapter } from '@forge-fr/cache';

const cache = createMemoryCacheAdapter({ maxEntries: 1_000 });
const value = await cache.getOrSet('user:42', async () => ({ id: '42' }), { ttlMs: 30_000 });
```

## Public Exports

### Cache Adapters, Safety & Plugin

- **Values**: `CacheError`, `CacheKeyError`, `normalizeTtlMs`, `parseSafeJson`, `redactCacheUrl`, `sanitizeCacheValue`, `validateCacheKey`, `validatePrefixOrTag`, `createMemoryCacheAdapter`, `createRedisCacheAdapter`, `CacheTokens`, `createCachePlugin`
- **Types**: `CacheAdapter`, `CacheDriver`, `CachePluginOptions`, `CacheSetOptions`, `CacheStats`, `MemoryCacheOptions`, `RedisCacheOptions`, `RedisClientLike`
