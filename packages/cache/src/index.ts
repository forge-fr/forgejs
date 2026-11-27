export { CacheError, CacheKeyError } from './errors.js';

export {
  normalizeTtlMs,
  parseSafeJson,
  redactCacheUrl,
  sanitizeCacheValue,
  validateCacheKey,
  validatePrefixOrTag,
} from './serialize.js';

export { createMemoryCacheAdapter } from './memory.js';
export { createRedisCacheAdapter } from './redis.js';
export { CacheTokens, createCachePlugin, type CachePluginOptions } from './plugin.js';

export type {
  CacheAdapter,
  CacheDriver,
  CacheSetOptions,
  CacheStats,
  MemoryCacheOptions,
  RedisCacheOptions,
  RedisClientLike,
} from './types.js';
