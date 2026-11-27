export type CacheDriver = 'memory' | 'redis';

export interface CacheSetOptions {
  /** Time-to-live in milliseconds. Must be a finite positive integer when provided. */
  readonly ttlMs?: number;
  /** Optional invalidation tags associated with this key. */
  readonly tags?: readonly string[];
}

export interface CacheStats {
  readonly hits: number;
  readonly misses: number;
  readonly sets: number;
  readonly deletes: number;
  readonly evictions: number;
  readonly size: number;
}

export interface CacheAdapter {
  readonly driver: CacheDriver;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  ping(): Promise<boolean>;
  get<T = unknown>(key: string): Promise<T | undefined>;
  set<T = unknown>(key: string, value: T, options?: CacheSetOptions): Promise<void>;
  has(key: string): Promise<boolean>;
  delete(key: string): Promise<boolean>;
  deleteByPrefix(prefix: string): Promise<number>;
  invalidateTag(tag: string): Promise<number>;
  ttl(key: string): Promise<number>;
  increment(key: string, delta?: number): Promise<number>;
  getOrSet<T>(
    key: string,
    loader: () => Promise<T> | T,
    options?: CacheSetOptions,
  ): Promise<T>;
  clear(): Promise<void>;
  stats(): CacheStats;
}

export interface MemoryCacheOptions {
  /** Maximum entries retained before LRU eviction. Default: `1000`. */
  readonly maxEntries?: number;
  /** Optional default TTL in milliseconds when `set` omits `ttlMs`. */
  readonly defaultTtlMs?: number;
  /** Optional deterministic clock (ms) for testing. Default: `Date.now`. */
  readonly now?: () => number;
}

/**
 * Structural subset of `ioredis` / compatible Redis clients required by `@forge-fr/cache`.
 */
export interface RedisClientLike {
  readonly status?: string;
  connect?(): Promise<void>;
  quit(): Promise<string | void>;
  ping(): Promise<string>;
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ...args: (string | number)[]): Promise<string | null>;
  del(...keys: string[]): Promise<number>;
  exists(...keys: string[]): Promise<number>;
  pttl(key: string): Promise<number>;
  incrby(key: string, delta: number): Promise<number>;
  scan(
    cursor: string | number,
    matchKeyword: 'MATCH',
    pattern: string,
    countKeyword: 'COUNT',
    count: number,
  ): Promise<[string, string[]]>;
  sadd?(key: string, ...members: string[]): Promise<number>;
  smembers?(key: string): Promise<string[]>;
}

export interface RedisCacheOptions {
  readonly client: RedisClientLike;
  /** Prefix automatically prepended to all keys. Default: `'forge:'`. */
  readonly keyPrefix?: string;
  /** Default TTL in ms when `set` omits `ttlMs`. */
  readonly defaultTtlMs?: number;
  /** `SCAN COUNT` batch size for prefix clearing. Default: `200`. */
  readonly scanCount?: number;
}
