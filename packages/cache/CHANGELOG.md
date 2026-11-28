# Changelog

## 0.1.0 (2026-11-25)

- Initial release of `@forge-fr/cache`:
  - `CacheAdapter` contract with strict key validation and prototype-safe JSON serialization.
  - Bounded `createMemoryCacheAdapter()` with O(1) LRU eviction, TTL expiration, single-flight `getOrSet()` coalescing, and tag invalidation.
  - Non-blocking `createRedisCacheAdapter()` compatible with `ioredis` (`RedisClientLike`) using `SCAN` prefix clearing and `SecretValue` URL redaction.
  - `createCachePlugin()` and `CacheTokens` for ForgeJS DI & health checks.

## [1.0.0] - 2026-11-27

### Added & Changed
- Synchronized `@forge-fr/cache` to `1.0.0` General Availability.

