import { ConfigurationError } from '@forge-fr/core';
import type {
  RateLimitAlgorithm,
  RateLimitConsumeResult,
  RateLimitStore,
} from './rate-limit.js';

const KEY_CONTROL_CHARS_RE = /[\r\n\u0000]/g;
const SQL_IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)?$/;
const MAX_RATE_LIMIT_KEY_LENGTH = 256;

function sanitizeStoreKey(rawKey: string): string {
  const cleaned = rawKey.replace(KEY_CONTROL_CHARS_RE, '_').trim();
  if (cleaned.length === 0) {
    return 'anonymous';
  }
  return cleaned.length > MAX_RATE_LIMIT_KEY_LENGTH
    ? cleaned.slice(0, MAX_RATE_LIMIT_KEY_LENGTH)
    : cleaned;
}

/**
 * Minimal duck-typed Redis client interface compatible with both `ioredis` (`eval`)
 * and `node-redis` v4+ (`sendCommand`), requiring zero hard runtime dependencies.
 */
export type RedisRateLimitClientLike =
  | {
      readonly eval: (
        script: string,
        numKeys: number,
        ...args: readonly (string | number)[]
      ) => Promise<unknown>;
    }
  | {
      readonly sendCommand: (args: readonly string[]) => Promise<unknown>;
    };

export interface RedisRateLimitStoreOptions {
  readonly client: RedisRateLimitClientLike;
  /** Key prefix for all Redis rate-limit counters (default: `'forge:rl:'`). */
  readonly keyPrefix?: string;
  /** Algorithm (`'sliding-window'` or `'fixed-window'`). Default: `'sliding-window'`. */
  readonly algorithm?: RateLimitAlgorithm;
  /** Injectable clock function for deterministic testing (default: `Date.now`). */
  readonly now?: () => number;
}

const REDIS_FIXED_WINDOW_LUA = `
local count = redis.call('INCR', KEYS[1])
local pttl = redis.call('PTTL', KEYS[1])
local windowMs = tonumber(ARGV[1])
local max = tonumber(ARGV[2])
local nowMs = tonumber(ARGV[3])
if count == 1 or pttl < 0 then
  redis.call('PEXPIRE', KEYS[1], windowMs)
  pttl = windowMs
end
local allowed = 0
if count <= max then
  allowed = 1
end
local remaining = max - count
if remaining < 0 then
  remaining = 0
end
return { allowed, remaining, nowMs + pttl }
`.trim();

const REDIS_SLIDING_WINDOW_LUA = `
local windowMs = tonumber(ARGV[1])
local max = tonumber(ARGV[2])
local nowMs = tonumber(ARGV[3])
local windowStartMs = tonumber(ARGV[4])
local prevCount = tonumber(redis.call('GET', KEYS[1]) or '0')
local currCount = tonumber(redis.call('GET', KEYS[2]) or '0')
local weight = 1 - ((nowMs - windowStartMs) / windowMs)
if weight < 0 then weight = 0 end
local weighted = (prevCount * weight) + currCount
local windowEndMs = windowStartMs + windowMs
if (weighted + 1) > (max + 0.000000001) then
  local resetAt = windowEndMs
  if prevCount > 0 and currCount < max then
    local allowedWeight = math.max(0, (max - 1 - currCount) / prevCount)
    local targetElapsed = math.ceil((1 - allowedWeight) * windowMs)
    if targetElapsed < 1 then targetElapsed = 1 end
    resetAt = math.min(windowEndMs, windowStartMs + targetElapsed)
  end
  return { 0, 0, resetAt }
end
currCount = redis.call('INCR', KEYS[2])
if currCount == 1 then
  redis.call('PEXPIRE', KEYS[2], windowMs * 2)
end
local newWeighted = (prevCount * weight) + currCount
local remaining = math.floor(max - newWeighted + 0.000000001)
if remaining < 0 then remaining = 0 end
return { 1, remaining, windowEndMs }
`.trim();

async function evalRedisScript(
  client: RedisRateLimitClientLike,
  script: string,
  keys: readonly string[],
  args: readonly string[],
): Promise<readonly [number, number, number]> {
  let raw: unknown;
  if ('eval' in client && typeof client.eval === 'function') {
    raw = await client.eval(script, keys.length, ...keys, ...args);
  } else if ('sendCommand' in client && typeof client.sendCommand === 'function') {
    raw = await client.sendCommand(['EVAL', script, String(keys.length), ...keys, ...args]);
  } else {
    throw new ConfigurationError(
      'RedisRateLimitClientLike must provide either an eval or sendCommand method',
    );
  }

  if (!Array.isArray(raw) || raw.length < 3) {
    throw new Error('Unexpected Redis Lua rate-limit script response');
  }
  return [Number(raw[0]), Number(raw[1]), Number(raw[2])];
}

/**
 * Distributed atomic Redis rate-limit store using single-roundtrip Lua scripts.
 * Works with `ioredis` and `node-redis` without bundling either client.
 */
export function createRedisRateLimitStore(
  options: RedisRateLimitStoreOptions,
): RateLimitStore {
  const prefix = options.keyPrefix ?? 'forge:rl:';
  if (KEY_CONTROL_CHARS_RE.test(prefix)) {
    throw new ConfigurationError('Redis rate-limit keyPrefix cannot contain control characters');
  }
  const algorithm: RateLimitAlgorithm = options.algorithm ?? 'sliding-window';
  const now = options.now ?? (() => Date.now());

  return {
    async consume(key: string, windowMs: number, max: number): Promise<RateLimitConsumeResult> {
      const safeKey = sanitizeStoreKey(key);
      const currentMs = now();

      if (algorithm === 'fixed-window') {
        const redisKey = `${prefix}${safeKey}`;
        const [allowedNum, remaining, resetAtMs] = await evalRedisScript(
          options.client,
          REDIS_FIXED_WINDOW_LUA,
          [redisKey],
          [String(windowMs), String(max), String(currentMs)],
        );
        return Object.freeze({
          allowed: allowedNum === 1,
          limit: max,
          remaining: Math.max(0, remaining),
          resetAtMs,
        });
      }

      const currentWindowIndex = Math.floor(currentMs / windowMs);
      const windowStartMs = currentWindowIndex * windowMs;
      const prevKey = `${prefix}${safeKey}:${currentWindowIndex - 1}`;
      const currKey = `${prefix}${safeKey}:${currentWindowIndex}`;
      const [allowedNum, remaining, resetAtMs] = await evalRedisScript(
        options.client,
        REDIS_SLIDING_WINDOW_LUA,
        [prevKey, currKey],
        [String(windowMs), String(max), String(currentMs), String(windowStartMs)],
      );
      return Object.freeze({
        allowed: allowedNum === 1,
        limit: max,
        remaining: Math.max(0, remaining),
        resetAtMs,
      });
    },
  };
}

export interface PostgresRateLimitQueryResult<Row = Record<string, unknown>> {
  readonly rows?: readonly Row[];
  readonly rowCount?: number | null;
}

/**
 * Minimal duck-typed PostgreSQL query executor compatible with `pg`, `postgres`,
 * or custom connection pools without hard runtime dependencies.
 */
export interface PostgresRateLimitSqlLike {
  query<Row = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<PostgresRateLimitQueryResult<Row> | readonly Row[]>;
}

export interface PostgresRateLimitStoreOptions {
  readonly sql: PostgresRateLimitSqlLike;
  /** SQL table name (optionally schema-qualified, e.g. `'public.forge_rate_limits'`). Default: `'forge_rate_limits'`. */
  readonly tableName?: string;
  /** Key prefix to namespace rate-limit buckets (default: `'rl:'`). */
  readonly keyPrefix?: string;
  /** Algorithm (`'sliding-window'` or `'fixed-window'`). Default: `'sliding-window'`. */
  readonly algorithm?: RateLimitAlgorithm;
  /** Injectable clock function for deterministic testing (default: `Date.now`). */
  readonly now?: () => number;
}

export interface PostgresRateLimitStore extends RateLimitStore {
  /** Creates the rate-limit table if it does not already exist. */
  ensureSchema(): Promise<void>;
  /** Deletes expired buckets to reclaim table space and returns deleted row count when reported. */
  pruneExpired(): Promise<number>;
}

interface PostgresRateLimitRow {
  readonly current_count: number | string;
  readonly previous_count: number | string;
  readonly last_allowed: boolean | number | string;
  readonly expires_at_ms: number | string;
}

function extractRows<Row>(
  result: PostgresRateLimitQueryResult<Row> | readonly Row[],
): readonly Row[] {
  if (Array.isArray(result)) {
    return result;
  }
  return (result as PostgresRateLimitQueryResult<Row>).rows ?? [];
}

/**
 * Distributed atomic PostgreSQL rate-limit store backed by single-statement
 * `INSERT ... ON CONFLICT DO UPDATE ... RETURNING` queries.
 */
export function createPostgresRateLimitStore(
  options: PostgresRateLimitStoreOptions,
): PostgresRateLimitStore {
  const tableName = options.tableName ?? 'forge_rate_limits';
  if (!SQL_IDENTIFIER_RE.test(tableName)) {
    throw new ConfigurationError(`Invalid PostgreSQL rate-limit table name "${tableName}"`);
  }
  const keyPrefix = options.keyPrefix ?? 'rl:';
  if (KEY_CONTROL_CHARS_RE.test(keyPrefix)) {
    throw new ConfigurationError('PostgreSQL rate-limit keyPrefix cannot contain control characters');
  }
  const algorithm: RateLimitAlgorithm = options.algorithm ?? 'sliding-window';
  const now = options.now ?? (() => Date.now());

  const createTableSql = `
CREATE TABLE IF NOT EXISTS ${tableName} (
  key TEXT PRIMARY KEY,
  window_index BIGINT NOT NULL,
  current_count INTEGER NOT NULL,
  previous_count INTEGER NOT NULL DEFAULT 0,
  last_allowed BOOLEAN NOT NULL DEFAULT TRUE,
  expires_at_ms BIGINT NOT NULL
)`.trim();

  const fixedUpsertSql = `
INSERT INTO ${tableName} (key, window_index, current_count, previous_count, last_allowed, expires_at_ms)
VALUES ($1, $2, 1, 0, TRUE, $3)
ON CONFLICT (key) DO UPDATE SET
  current_count = CASE
    WHEN ${tableName}.expires_at_ms <= $4 THEN 1
    WHEN ${tableName}.current_count < $5 THEN ${tableName}.current_count + 1
    ELSE ${tableName}.current_count
  END,
  last_allowed = CASE
    WHEN ${tableName}.expires_at_ms <= $4 THEN TRUE
    WHEN ${tableName}.current_count < $5 THEN TRUE
    ELSE FALSE
  END,
  window_index = CASE
    WHEN ${tableName}.expires_at_ms <= $4 THEN $2
    ELSE ${tableName}.window_index
  END,
  previous_count = 0,
  expires_at_ms = CASE
    WHEN ${tableName}.expires_at_ms <= $4 THEN $3
    ELSE ${tableName}.expires_at_ms
  END
RETURNING current_count, previous_count, last_allowed, expires_at_ms`.trim();

  const slidingUpsertSql = `
INSERT INTO ${tableName} (key, window_index, current_count, previous_count, last_allowed, expires_at_ms)
VALUES ($1, $2, 1, 0, TRUE, $3)
ON CONFLICT (key) DO UPDATE SET
  previous_count = CASE
    WHEN ${tableName}.window_index = $2 THEN ${tableName}.previous_count
    WHEN ${tableName}.window_index = $2 - 1 THEN ${tableName}.current_count
    ELSE 0
  END,
  current_count = CASE
    WHEN (
      (CASE
        WHEN ${tableName}.window_index = $2 THEN ${tableName}.previous_count
        WHEN ${tableName}.window_index = $2 - 1 THEN ${tableName}.current_count
        ELSE 0
      END) * $5 +
      (CASE WHEN ${tableName}.window_index = $2 THEN ${tableName}.current_count ELSE 0 END) + 1
    ) <= ($4 + 0.000000001)
    THEN (CASE WHEN ${tableName}.window_index = $2 THEN ${tableName}.current_count ELSE 0 END) + 1
    ELSE (CASE WHEN ${tableName}.window_index = $2 THEN ${tableName}.current_count ELSE 0 END)
  END,
  last_allowed = (
    (CASE
      WHEN ${tableName}.window_index = $2 THEN ${tableName}.previous_count
      WHEN ${tableName}.window_index = $2 - 1 THEN ${tableName}.current_count
      ELSE 0
    END) * $5 +
    (CASE WHEN ${tableName}.window_index = $2 THEN ${tableName}.current_count ELSE 0 END) + 1
  ) <= ($4 + 0.000000001),
  window_index = $2,
  expires_at_ms = $3
RETURNING current_count, previous_count, last_allowed, expires_at_ms`.trim();

  const pruneSql = `DELETE FROM ${tableName} WHERE expires_at_ms <= $1`;

  return {
    async ensureSchema(): Promise<void> {
      await options.sql.query(createTableSql);
    },

    async pruneExpired(): Promise<number> {
      const res = await options.sql.query(pruneSql, [now()]);
      if (!Array.isArray(res) && typeof (res as PostgresRateLimitQueryResult).rowCount === 'number') {
        return (res as PostgresRateLimitQueryResult).rowCount ?? 0;
      }
      return 0;
    },

    async consume(key: string, windowMs: number, max: number): Promise<RateLimitConsumeResult> {
      const safeKey = `${keyPrefix}${sanitizeStoreKey(key)}`;
      const currentMs = now();
      const currentWindowIndex = Math.floor(currentMs / windowMs);

      if (algorithm === 'fixed-window') {
        const expiresAtMs = currentMs + windowMs;
        const result = await options.sql.query<PostgresRateLimitRow>(fixedUpsertSql, [
          safeKey,
          currentWindowIndex,
          expiresAtMs,
          currentMs,
          max,
        ]);
        const row = extractRows(result)[0];
        if (!row) {
          throw new Error('PostgreSQL rate-limit upsert returned no rows');
        }
        const count = Number(row.current_count);
        const allowed = row.last_allowed === true || row.last_allowed === 1 || row.last_allowed === 't';
        return Object.freeze({
          allowed,
          limit: max,
          remaining: allowed ? Math.max(0, max - count) : 0,
          resetAtMs: Number(row.expires_at_ms),
        });
      }

      const windowStartMs = currentWindowIndex * windowMs;
      const elapsedInWindow = currentMs - windowStartMs;
      const previousWeight = Math.max(0, 1 - elapsedInWindow / windowMs);
      const windowEndMs = windowStartMs + windowMs;
      const expiresAtMs = windowStartMs + windowMs * 2;

      const result = await options.sql.query<PostgresRateLimitRow>(slidingUpsertSql, [
        safeKey,
        currentWindowIndex,
        expiresAtMs,
        max,
        previousWeight,
      ]);
      const row = extractRows(result)[0];
      if (!row) {
        throw new Error('PostgreSQL rate-limit upsert returned no rows');
      }

      const currCount = Number(row.current_count);
      const prevCount = Number(row.previous_count);
      const allowed = row.last_allowed === true || row.last_allowed === 1 || row.last_allowed === 't';

      if (!allowed) {
        let resetAtMs = windowEndMs;
        if (prevCount > 0 && currCount < max) {
          const allowedPreviousWeight = Math.max(0, (max - 1 - currCount) / prevCount);
          const targetElapsed = Math.ceil((1 - allowedPreviousWeight) * windowMs);
          resetAtMs = Math.min(windowEndMs, windowStartMs + Math.max(1, targetElapsed));
        }
        return Object.freeze({
          allowed: false,
          limit: max,
          remaining: 0,
          resetAtMs,
        });
      }

      const weighted = prevCount * previousWeight + currCount;
      return Object.freeze({
        allowed: true,
        limit: max,
        remaining: Math.max(0, Math.floor(max - weighted + 1e-9)),
        resetAtMs: windowEndMs,
      });
    },
  };
}
