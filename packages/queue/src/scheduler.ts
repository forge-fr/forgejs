import { QueueValidationError } from './errors.js';
import { sanitizePayload, validateIdempotencyKey, validateJobName } from './sanitize.js';
import type {
  EnqueueOptions,
  PostgresQueueSqlLike,
  QueueAdapter,
  QueueJob,
  RedisQueueClientLike,
} from './types.js';

const CRON_MACROS: Readonly<Record<string, string>> = Object.freeze({
  '@yearly': '0 0 1 1 *',
  '@annually': '0 0 1 1 *',
  '@monthly': '0 0 1 * *',
  '@weekly': '0 0 * * 0',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@hourly': '0 * * * *',
  '@minutely': '* * * * *',
});

const MONTH_ALIASES: Readonly<Record<string, number>> = Object.freeze({
  JAN: 1,
  FEB: 2,
  MAR: 3,
  APR: 4,
  MAY: 5,
  JUN: 6,
  JUL: 7,
  AUG: 8,
  SEP: 9,
  OCT: 10,
  NOV: 11,
  DEC: 12,
});

const DOW_ALIASES: Readonly<Record<string, number>> = Object.freeze({
  SUN: 0,
  MON: 1,
  TUE: 2,
  WED: 3,
  THU: 4,
  FRI: 5,
  SAT: 6,
});

const SHORT_WEEKDAY_MAP: Readonly<Record<string, number>> = Object.freeze({
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
});

const SAFE_IDENTIFIER_REGEX = /^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/;

function assertSafeIdentifier(value: string, label: string): string {
  if (!SAFE_IDENTIFIER_REGEX.test(value)) {
    throw new QueueValidationError(`Invalid SQL ${label} "${value}"`);
  }
  return value;
}

export interface ParsedCronExpression {
  readonly expression: string;
  readonly hasSeconds: boolean;
  readonly seconds: ReadonlySet<number>;
  readonly minutes: ReadonlySet<number>;
  readonly hours: ReadonlySet<number>;
  readonly daysOfMonth: ReadonlySet<number>;
  readonly months: ReadonlySet<number>;
  readonly daysOfWeek: ReadonlySet<number>;
  readonly isDayOfMonthWildcard: boolean;
  readonly isDayOfWeekWildcard: boolean;
}

function parseFieldToken(
  token: string,
  min: number,
  max: number,
  aliases?: Readonly<Record<string, number>>,
  normalizeSevenToZero = false,
): number {
  const upper = token.toUpperCase();
  if (aliases && upper in aliases) {
    return aliases[upper]!;
  }
  if (!/^\d+$/.test(token)) {
    throw new QueueValidationError(`Invalid cron field token "${token}"`);
  }
  let num = Number.parseInt(token, 10);
  if (normalizeSevenToZero && num === 7) {
    num = 0;
  }
  if (!Number.isInteger(num) || num < min || num > max) {
    throw new QueueValidationError(
      `Cron field value "${token}" out of range [${min}, ${max}]`,
    );
  }
  return num;
}

function parseCronField(
  rawField: string,
  min: number,
  max: number,
  aliases?: Readonly<Record<string, number>>,
  normalizeSevenToZero = false,
): { readonly values: ReadonlySet<number>; readonly isWildcard: boolean } {
  const trimmed = rawField.trim();
  if (trimmed.length === 0) {
    throw new QueueValidationError('Empty cron field');
  }
  const isWildcard = trimmed === '*' || trimmed === '?';
  const values = new Set<number>();

  const parts = trimmed.split(',');
  for (const part of parts) {
    const [rangePart, stepPart, extra] = part.split('/');
    if (extra !== undefined || !rangePart) {
      throw new QueueValidationError(`Invalid cron field segment "${part}"`);
    }

    let step = 1;
    if (stepPart !== undefined) {
      if (!/^\d+$/.test(stepPart)) {
        throw new QueueValidationError(`Invalid cron step value "${stepPart}"`);
      }
      step = Number.parseInt(stepPart, 10);
      if (!Number.isInteger(step) || step < 1) {
        throw new QueueValidationError(`Cron step must be >= 1 in "${part}"`);
      }
    }

    let rangeStart = min;
    let rangeEnd = max;

    if (rangePart === '*' || rangePart === '?') {
      rangeStart = min;
      rangeEnd = max;
    } else if (rangePart.includes('-')) {
      const [startStr, endStr, rest] = rangePart.split('-');
      if (rest !== undefined || !startStr || !endStr) {
        throw new QueueValidationError(`Invalid cron range "${rangePart}"`);
      }
      rangeStart = parseFieldToken(startStr, min, max, aliases, normalizeSevenToZero);
      rangeEnd = parseFieldToken(endStr, min, max, aliases, normalizeSevenToZero);
      if (normalizeSevenToZero && rangeEnd === 0 && endStr === '7') {
        rangeEnd = 7;
      }
      if (rangeEnd < rangeStart) {
        throw new QueueValidationError(
          `Cron range end (${rangeEnd}) cannot be less than start (${rangeStart}) in "${rangePart}"`,
        );
      }
    } else {
      const single = parseFieldToken(rangePart, min, max, aliases, normalizeSevenToZero);
      if (stepPart === undefined) {
        values.add(single);
        continue;
      }
      rangeStart = single;
      rangeEnd = max;
    }

    for (let v = rangeStart; v <= rangeEnd; v += step) {
      const normalized = normalizeSevenToZero && v === 7 ? 0 : v;
      values.add(normalized);
    }
  }

  if (values.size === 0) {
    throw new QueueValidationError(`Cron field "${rawField}" matched zero values`);
  }

  return { values, isWildcard };
}

/**
 * Parses a standard 5-field (`min hour dom month dow`), 6-field (`sec min hour dom month dow`),
 * or macro (`@hourly`, `@daily`, `@weekly`, `@monthly`, `@yearly`) cron expression.
 */
export function parseCronExpression(expression: string): ParsedCronExpression {
  if (typeof expression !== 'string' || expression.trim().length === 0) {
    throw new QueueValidationError('Cron expression must be a non-empty string');
  }
  const trimmed = expression.trim();
  const resolved = CRON_MACROS[trimmed.toLowerCase()] ?? trimmed;
  const tokens = resolved.split(/\s+/);

  if (tokens.length !== 5 && tokens.length !== 6) {
    throw new QueueValidationError(
      `Cron expression "${expression}" must have 5 or 6 fields (received ${tokens.length})`,
    );
  }

  const hasSeconds = tokens.length === 6;
  const secField = hasSeconds ? parseCronField(tokens[0]!, 0, 59) : { values: new Set([0]), isWildcard: false };
  const offset = hasSeconds ? 1 : 0;

  const minField = parseCronField(tokens[offset]!, 0, 59);
  const hourField = parseCronField(tokens[offset + 1]!, 0, 23);
  const domField = parseCronField(tokens[offset + 2]!, 1, 31);
  const monthField = parseCronField(tokens[offset + 3]!, 1, 12, MONTH_ALIASES);
  const dowField = parseCronField(tokens[offset + 4]!, 0, 7, DOW_ALIASES, true);

  return Object.freeze({
    expression: trimmed,
    hasSeconds,
    seconds: secField.values,
    minutes: minField.values,
    hours: hourField.values,
    daysOfMonth: domField.values,
    months: monthField.values,
    daysOfWeek: dowField.values,
    isDayOfMonthWildcard: domField.isWildcard,
    isDayOfWeekWildcard: dowField.isWildcard,
  });
}

interface ZonedDateParts {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
  readonly dayOfWeek: number;
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function getTimezoneFormatter(timezone: string): Intl.DateTimeFormat {
  let fmt = formatterCache.get(timezone);
  if (!fmt) {
    try {
      fmt = new Intl.DateTimeFormat('en-US', {
        timeZone: timezone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        weekday: 'short',
        hourCycle: 'h23',
      });
      formatterCache.set(timezone, fmt);
    } catch {
      throw new QueueValidationError(`Invalid IANA timezone "${timezone}"`);
    }
  }
  return fmt;
}

export function validateTimezone(timezone: string): string {
  getTimezoneFormatter(timezone);
  return timezone;
}

function getZonedDateParts(timestampMs: number, timezone: string): ZonedDateParts {
  if (timezone === 'UTC' || timezone === 'Etc/UTC') {
    const d = new Date(timestampMs);
    return {
      year: d.getUTCFullYear(),
      month: d.getUTCMonth() + 1,
      day: d.getUTCDate(),
      hour: d.getUTCHours(),
      minute: d.getUTCMinutes(),
      second: d.getUTCSeconds(),
      dayOfWeek: d.getUTCDay(),
    };
  }

  const fmt = getTimezoneFormatter(timezone);
  const parts = fmt.formatToParts(new Date(timestampMs));
  let year = 1970;
  let month = 1;
  let day = 1;
  let hour = 0;
  let minute = 0;
  let second = 0;
  let dayOfWeek = 0;

  for (const p of parts) {
    if (p.type === 'year') year = Number.parseInt(p.value, 10);
    else if (p.type === 'month') month = Number.parseInt(p.value, 10);
    else if (p.type === 'day') day = Number.parseInt(p.value, 10);
    else if (p.type === 'hour') {
      const h = Number.parseInt(p.value, 10);
      hour = h === 24 ? 0 : h;
    } else if (p.type === 'minute') minute = Number.parseInt(p.value, 10);
    else if (p.type === 'second') second = Number.parseInt(p.value, 10);
    else if (p.type === 'weekday') {
      dayOfWeek = SHORT_WEEKDAY_MAP[p.value] ?? 0;
    }
  }

  return { year, month, day, hour, minute, second, dayOfWeek };
}

function matchesDayFields(parsed: ParsedCronExpression, parts: ZonedDateParts): boolean {
  const domMatch = parsed.daysOfMonth.has(parts.day);
  const dowMatch = parsed.daysOfWeek.has(parts.dayOfWeek);

  if (parsed.isDayOfMonthWildcard && parsed.isDayOfWeekWildcard) {
    return true;
  }
  if (parsed.isDayOfMonthWildcard) {
    return dowMatch;
  }
  if (parsed.isDayOfWeekWildcard) {
    return domMatch;
  }
  // Standard Vixie cron semantics: when both DOM and DOW are restricted (non-wildcard), match if EITHER matches
  return domMatch || dowMatch;
}

export function matchesCronTimestamp(
  cronOrParsed: string | ParsedCronExpression,
  timestampMs: number,
  timezone = 'UTC',
): boolean {
  const parsed =
    typeof cronOrParsed === 'string' ? parseCronExpression(cronOrParsed) : cronOrParsed;
  const parts = getZonedDateParts(timestampMs, timezone);

  return (
    parsed.seconds.has(parts.second) &&
    parsed.minutes.has(parts.minute) &&
    parsed.hours.has(parts.hour) &&
    parsed.months.has(parts.month) &&
    matchesDayFields(parsed, parts)
  );
}

/**
 * Computes the next execution timestamp (in epoch ms) strictly after `afterTimestampMs`
 * that satisfies `cronOrParsed` in the specified IANA `timezone` (default: `'UTC'`).
 */
export function getNextCronTimestamp(
  cronOrParsed: string | ParsedCronExpression,
  afterTimestampMs: number,
  timezone = 'UTC',
): number {
  const parsed =
    typeof cronOrParsed === 'string' ? parseCronExpression(cronOrParsed) : cronOrParsed;
  validateTimezone(timezone);

  const stepMs = parsed.hasSeconds ? 1_000 : 60_000;
  let candidate = Math.floor(afterTimestampMs / stepMs) * stepMs + stepMs;
  const maxSearchMs = afterTimestampMs + 4 * 366 * 24 * 60 * 60 * 1_000; // up to 4 years (leap-year safe)

  while (candidate <= maxSearchMs) {
    const parts = getZonedDateParts(candidate, timezone);
    const msToNextHour = (60 - parts.minute) * 60_000 - parts.second * 1_000;
    const msToNextMinute = (60 - parts.second) * 1_000;

    if (!parsed.months.has(parts.month)) {
      candidate += msToNextHour;
      continue;
    }

    if (!matchesDayFields(parsed, parts)) {
      candidate += msToNextHour;
      continue;
    }

    if (!parsed.hours.has(parts.hour)) {
      candidate += msToNextHour;
      continue;
    }

    if (!parsed.minutes.has(parts.minute)) {
      candidate += msToNextMinute;
      continue;
    }

    if (parsed.hasSeconds && !parsed.seconds.has(parts.second)) {
      candidate += 1_000;
      continue;
    }

    return candidate;
  }

  throw new QueueValidationError(
    `Unable to find next occurrence for cron expression "${parsed.expression}" within 4 years`,
  );
}

export interface SchedulerLockAdapter {
  readonly driver: 'memory' | 'redis' | 'postgres' | 'custom';
  /**
   * Attempts to acquire an exclusive distributed lease on `lockKey` for `ttlMs`.
   * Returns `true` if the lease was acquired (or already held by `ownerId`), `false` otherwise.
   */
  acquire(lockKey: string, ownerId: string, ttlMs: number, nowMs?: number): Promise<boolean>;
  /**
   * Releases a previously acquired lease if still owned by `ownerId`.
   */
  release(lockKey: string, ownerId: string): Promise<boolean>;
  /**
   * Extends an existing lease held by `ownerId` for an additional `ttlMs`.
   */
  renew?(lockKey: string, ownerId: string, ttlMs: number, nowMs?: number): Promise<boolean>;
}

export interface MemorySchedulerLockOptions {
  readonly now?: () => number;
}

export interface MemorySchedulerLockStore extends SchedulerLockAdapter {
  readonly driver: 'memory';
  isLocked(lockKey: string, nowMs?: number): boolean;
  clear(): void;
}

/**
 * Creates a shareable in-memory lease lock adapter for deterministic single-process or multi-worker tests.
 */
export function createMemorySchedulerLockAdapter(
  options: MemorySchedulerLockOptions = {},
): MemorySchedulerLockStore {
  const clock = options.now ?? (() => Date.now());
  const leases = new Map<string, { ownerId: string; expiresAt: number }>();

  return {
    driver: 'memory',

    async acquire(lockKey: string, ownerId: string, ttlMs: number, explicitNow?: number): Promise<boolean> {
      const now = explicitNow ?? clock();
      const existing = leases.get(lockKey);
      if (existing && existing.expiresAt > now && existing.ownerId !== ownerId) {
        return false;
      }
      leases.set(lockKey, { ownerId, expiresAt: now + Math.max(1, ttlMs) });
      return true;
    },

    async release(lockKey: string, ownerId: string): Promise<boolean> {
      const existing = leases.get(lockKey);
      if (!existing || existing.ownerId !== ownerId) {
        return false;
      }
      leases.delete(lockKey);
      return true;
    },

    async renew(lockKey: string, ownerId: string, ttlMs: number, explicitNow?: number): Promise<boolean> {
      const now = explicitNow ?? clock();
      const existing = leases.get(lockKey);
      if (!existing || existing.ownerId !== ownerId || existing.expiresAt <= now) {
        return false;
      }
      leases.set(lockKey, { ownerId, expiresAt: now + Math.max(1, ttlMs) });
      return true;
    },

    isLocked(lockKey: string, explicitNow?: number): boolean {
      const now = explicitNow ?? clock();
      const existing = leases.get(lockKey);
      return existing !== undefined && existing.expiresAt > now;
    },

    clear(): void {
      leases.clear();
    },
  };
}

export interface RedisSchedulerLockOptions {
  /** Key prefix for Redis scheduler leases. Default: `'forge:scheduler:lock:'`. */
  readonly keyPrefix?: string;
}

const REDIS_RELEASE_LUA = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("DEL", KEYS[1])
else
  return 0
end
`;

const REDIS_RENEW_LUA = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("PEXPIRE", KEYS[1], ARGV[2])
else
  return 0
end
`;

/**
 * Structural Redis distributed lease lock adapter (`SET key owner PX ttl NX`) with zero external dependencies.
 */
export function createRedisSchedulerLockAdapter(
  client: RedisQueueClientLike,
  options: RedisSchedulerLockOptions = {},
): SchedulerLockAdapter {
  const prefix = options.keyPrefix ?? 'forge:scheduler:lock:';

  return {
    driver: 'redis',

    async acquire(lockKey: string, ownerId: string, ttlMs: number): Promise<boolean> {
      const fullKey = `${prefix}${lockKey}`;
      const safeTtl = Math.max(1, Math.round(ttlMs));
      const res = await client.set(fullKey, ownerId, 'PX', safeTtl, 'NX');
      if (res === 'OK' || res === true) {
        return true;
      }
      const currentOwner = await client.get(fullKey);
      if (currentOwner === ownerId) {
        await client.set(fullKey, ownerId, 'PX', safeTtl);
        return true;
      }
      return false;
    },

    async release(lockKey: string, ownerId: string): Promise<boolean> {
      const fullKey = `${prefix}${lockKey}`;
      if (typeof client.eval === 'function') {
        const res = await client.eval(REDIS_RELEASE_LUA, 1, fullKey, ownerId);
        return Number(res) === 1;
      }
      const currentOwner = await client.get(fullKey);
      if (currentOwner === ownerId) {
        await client.del(fullKey);
        return true;
      }
      return false;
    },

    async renew(lockKey: string, ownerId: string, ttlMs: number): Promise<boolean> {
      const fullKey = `${prefix}${lockKey}`;
      const safeTtl = Math.max(1, Math.round(ttlMs));
      if (typeof client.eval === 'function') {
        const res = await client.eval(REDIS_RENEW_LUA, 1, fullKey, ownerId, safeTtl);
        return Number(res) === 1;
      }
      const currentOwner = await client.get(fullKey);
      if (currentOwner === ownerId) {
        await client.set(fullKey, ownerId, 'PX', safeTtl);
        return true;
      }
      return false;
    },
  };
}

export interface PostgresSchedulerLockOptions {
  /** Table name for distributed scheduler leases. Default: `'forge_scheduler_locks'`. */
  readonly tableName?: string;
  /** Schema name. Default: `'public'`. */
  readonly schemaName?: string;
  /** Automatically run `CREATE TABLE IF NOT EXISTS` before first lock acquisition. Default: `true`. */
  readonly autoCreateSchema?: boolean;
  /** Optional deterministic clock. Default: `Date.now`. */
  readonly now?: () => number;
}

export interface PostgresSchedulerLockAdapter extends SchedulerLockAdapter {
  readonly driver: 'postgres';
  ensureSchema(): Promise<void>;
}

function normalizeSqlRunner(sql: PostgresQueueSqlLike): {
  query<TRow = Record<string, unknown>>(
    text: string,
    params?: readonly unknown[],
  ): Promise<readonly TRow[]>;
} {
  if ('query' in sql && typeof sql.query === 'function') {
    return {
      query: async <TRow = Record<string, unknown>>(
        text: string,
        params: readonly unknown[] = [],
      ): Promise<readonly TRow[]> => {
        const res = await sql.query<TRow>(text, params);
        return res.rows;
      },
    };
  }
  if ('unsafe' in sql && typeof sql.unsafe === 'function') {
    return {
      query: async <TRow = Record<string, unknown>>(
        text: string,
        params: readonly unknown[] = [],
      ): Promise<readonly TRow[]> => {
        return await sql.unsafe<TRow>(text, params);
      },
    };
  }
  throw new QueueValidationError(
    'PostgresQueueSqlLike must implement either query(text, params) or unsafe(text, params)',
  );
}

/**
 * Structural PostgreSQL distributed lease lock adapter using atomic `INSERT ... ON CONFLICT DO UPDATE`.
 */
export function createPostgresSchedulerLockAdapter(
  sql: PostgresQueueSqlLike,
  options: PostgresSchedulerLockOptions = {},
): PostgresSchedulerLockAdapter {
  const runner = normalizeSqlRunner(sql);
  const schemaName = assertSafeIdentifier(options.schemaName ?? 'public', 'schemaName');
  const tableName = assertSafeIdentifier(
    options.tableName ?? 'forge_scheduler_locks',
    'tableName',
  );
  const qualifiedTable = `"${schemaName}"."${tableName}"`;
  const autoCreateSchema = options.autoCreateSchema ?? true;
  const clock = options.now ?? (() => Date.now());
  let schemaEnsured = false;

  async function ensureReady(): Promise<void> {
    if (!schemaEnsured && autoCreateSchema) {
      await runner.query(
        `CREATE TABLE IF NOT EXISTS ${qualifiedTable} (
          lock_key TEXT PRIMARY KEY,
          owner_id TEXT NOT NULL,
          expires_at BIGINT NOT NULL,
          updated_at BIGINT NOT NULL
        )`,
      );
      schemaEnsured = true;
    }
  }

  return {
    driver: 'postgres',

    async ensureSchema(): Promise<void> {
      await runner.query(
        `CREATE TABLE IF NOT EXISTS ${qualifiedTable} (
          lock_key TEXT PRIMARY KEY,
          owner_id TEXT NOT NULL,
          expires_at BIGINT NOT NULL,
          updated_at BIGINT NOT NULL
        )`,
      );
      schemaEnsured = true;
    },

    async acquire(lockKey: string, ownerId: string, ttlMs: number, explicitNow?: number): Promise<boolean> {
      await ensureReady();
      const now = explicitNow ?? clock();
      const expiresAt = now + Math.max(1, Math.round(ttlMs));
      const rows = await runner.query<{ readonly lock_key: string }>(
        `INSERT INTO ${qualifiedTable} (lock_key, owner_id, expires_at, updated_at)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (lock_key) DO UPDATE
           SET owner_id = EXCLUDED.owner_id,
               expires_at = EXCLUDED.expires_at,
               updated_at = EXCLUDED.updated_at
         WHERE ${qualifiedTable}.expires_at <= $4
            OR ${qualifiedTable}.owner_id = $2
         RETURNING lock_key`,
        [lockKey, ownerId, expiresAt, now],
      );
      return rows.length > 0;
    },

    async release(lockKey: string, ownerId: string): Promise<boolean> {
      await ensureReady();
      const rows = await runner.query<{ readonly lock_key: string }>(
        `DELETE FROM ${qualifiedTable}
         WHERE lock_key = $1 AND owner_id = $2
         RETURNING lock_key`,
        [lockKey, ownerId],
      );
      return rows.length > 0;
    },

    async renew(lockKey: string, ownerId: string, ttlMs: number, explicitNow?: number): Promise<boolean> {
      await ensureReady();
      const now = explicitNow ?? clock();
      const expiresAt = now + Math.max(1, Math.round(ttlMs));
      const rows = await runner.query<{ readonly lock_key: string }>(
        `UPDATE ${qualifiedTable}
         SET expires_at = $3,
             updated_at = $4
         WHERE lock_key = $1
           AND owner_id = $2
           AND expires_at > $4
         RETURNING lock_key`,
        [lockKey, ownerId, expiresAt, now],
      );
      return rows.length > 0;
    },
  };
}

export interface ScheduledJobTickContext {
  readonly scheduleId: string;
  readonly jobName: string;
  readonly slotTimestampMs: number;
  readonly tickKey: string;
  readonly timezone: string;
  readonly nodeId: string;
}

export interface ScheduledJobDefinition<TPayload = unknown> {
  /** Unique schedule identifier (e.g. `'daily-billing-rollup'`). */
  readonly id: string;
  /** Target queue job name enqueued on each due tick (defaults to `id`). */
  readonly jobName?: string;
  /** Cron expression (5 or 6 fields, or `@hourly` / `@daily` / etc.). Mutually exclusive with `everyMs`. */
  readonly cron?: string;
  /** Fixed interval in milliseconds. Mutually exclusive with `cron`. */
  readonly everyMs?: number;
  /** IANA timezone for cron evaluation (default: `'UTC'`). */
  readonly timezone?: string;
  /** Static payload or dynamic factory evaluated on each due tick. */
  readonly payload?: TPayload | ((ctx: ScheduledJobTickContext) => TPayload | Promise<TPayload>);
  /** Optional `EnqueueOptions` forwarded to `queue.enqueue()` (e.g. `priority`, `maxAttempts`, `backoff`, `timeoutMs`). */
  readonly enqueueOptions?: Omit<EnqueueOptions, 'idempotencyKey'>;
  /** Optional lease duration in milliseconds for this schedule slot (default: scheduler `defaultLeaseTtlMs`). */
  readonly leaseTtlMs?: number;
  /** Optional custom idempotent tick key factory (default: `schedule:<id>:<slotTimestampMs>`). */
  readonly buildTickKey?: (ctx: Omit<ScheduledJobTickContext, 'tickKey'>) => string;
  /** Optional inline callback invoked after (or instead of) enqueuing the job. */
  readonly onTick?: (ctx: ScheduledJobTickContext, job?: QueueJob<TPayload>) => Promise<void> | void;
  /** Start in paused state if `false` (default: `true`). */
  readonly enabled?: boolean;
}

export interface RegisteredScheduleInfo {
  readonly id: string;
  readonly jobName: string;
  readonly cron?: string;
  readonly everyMs?: number;
  readonly timezone: string;
  readonly enabled: boolean;
  readonly nextRunAt: number;
  readonly lastRunAt?: number;
  readonly lastTickKey?: string;
  readonly totalRuns: number;
}

export interface SchedulerTickResult {
  readonly timestampMs: number;
  readonly evaluated: number;
  readonly enqueued: number;
  readonly executedInline: number;
  readonly skippedLocked: number;
  readonly skippedNotDue: number;
  readonly jobs: readonly QueueJob[];
  readonly tickKeys: readonly string[];
}

export interface JobSchedulerOptions {
  /** Target `QueueAdapter` where due scheduled jobs are enqueued. */
  readonly queue?: QueueAdapter;
  /** Distributed lease lock adapter preventing duplicate execution across replicas (default: in-memory lock adapter). */
  readonly lockAdapter?: SchedulerLockAdapter;
  /** Unique scheduler node/replica identifier (default: random UUID). */
  readonly nodeId?: string;
  /** Background polling interval in ms when `.start()` is active (default: `1_000`). */
  readonly tickIntervalMs?: number;
  /** Default distributed lease TTL in ms for each scheduled slot (default: `60_000`). */
  readonly defaultLeaseTtlMs?: number;
  /** Optional initial schedules to register on creation. */
  readonly schedules?: readonly ScheduledJobDefinition[];
  /** Optional deterministic clock (default: `Date.now`). */
  readonly now?: () => number;
  /** Optional error hook when a tick fails. */
  readonly onError?: (scheduleId: string, error: unknown) => void | Promise<void>;
}

export interface JobScheduler {
  readonly nodeId: string;
  readonly running: boolean;
  register<TPayload = unknown>(definition: ScheduledJobDefinition<TPayload>): RegisteredScheduleInfo;
  unregister(scheduleId: string): boolean;
  pause(scheduleId: string): boolean;
  resume(scheduleId: string, nowMs?: number): boolean;
  get(scheduleId: string): RegisteredScheduleInfo | undefined;
  list(): readonly RegisteredScheduleInfo[];
  /**
   * Deterministic evaluation cycle: checks all enabled schedules against `nowMs`,
   * acquires distributed slot leases, and enqueues due jobs with idempotent tick keys.
   */
  tick(nowMs?: number): Promise<SchedulerTickResult>;
  start(): void;
  stop(): Promise<void>;
}

interface InternalScheduleEntry {
  readonly definition: ScheduledJobDefinition<unknown>;
  readonly id: string;
  readonly jobName: string;
  readonly parsedCron?: ParsedCronExpression;
  readonly everyMs?: number;
  readonly timezone: string;
  readonly leaseTtlMs: number;
  enabled: boolean;
  nextRunAt: number;
  lastRunAt?: number;
  lastTickKey?: string;
  totalRuns: number;
}

function computeNextSlot(
  entry: {
    readonly parsedCron?: ParsedCronExpression;
    readonly everyMs?: number;
    readonly timezone: string;
  },
  afterMs: number,
): number {
  if (entry.parsedCron) {
    return getNextCronTimestamp(entry.parsedCron, afterMs, entry.timezone);
  }
  const every = entry.everyMs!;
  // Align interval slots deterministically to integer multiples of everyMs so multi-node replicas agree on slot timestamps!
  return (Math.floor(afterMs / every) + 1) * every;
}

export function createJobScheduler(options: JobSchedulerOptions = {}): JobScheduler {
  const nodeId = options.nodeId ?? globalThis.crypto.randomUUID();
  const lockAdapter = options.lockAdapter ?? createMemorySchedulerLockAdapter(
    options.now ? { now: options.now } : {},
  );
  const tickIntervalMs = Math.max(10, options.tickIntervalMs ?? 1_000);
  const defaultLeaseTtlMs = Math.max(100, options.defaultLeaseTtlMs ?? 60_000);
  const clock = options.now ?? (() => Date.now());

  const schedules = new Map<string, InternalScheduleEntry>();
  let running = false;
  let timer: ReturnType<typeof setInterval> | null = null;
  let activeTickPromise: Promise<SchedulerTickResult> | null = null;

  function toPublicInfo(entry: InternalScheduleEntry): RegisteredScheduleInfo {
    return Object.freeze({
      id: entry.id,
      jobName: entry.jobName,
      ...(entry.definition.cron !== undefined ? { cron: entry.definition.cron } : {}),
      ...(entry.everyMs !== undefined ? { everyMs: entry.everyMs } : {}),
      timezone: entry.timezone,
      enabled: entry.enabled,
      nextRunAt: entry.nextRunAt,
      ...(entry.lastRunAt !== undefined ? { lastRunAt: entry.lastRunAt } : {}),
      ...(entry.lastTickKey !== undefined ? { lastTickKey: entry.lastTickKey } : {}),
      totalRuns: entry.totalRuns,
    });
  }

  function register<TPayload = unknown>(
    definition: ScheduledJobDefinition<TPayload>,
  ): RegisteredScheduleInfo {
    if (typeof definition.id !== 'string' || definition.id.trim().length === 0) {
      throw new QueueValidationError('Schedule id must be a non-empty string');
    }
    const id = validateJobName(definition.id.trim());
    const jobName = validateJobName((definition.jobName ?? id).trim());

    const hasCron = definition.cron !== undefined;
    const hasInterval = definition.everyMs !== undefined;
    if ((hasCron && hasInterval) || (!hasCron && !hasInterval)) {
      throw new QueueValidationError(
        `Schedule "${id}" must specify exactly one of "cron" or "everyMs"`,
      );
    }

    let parsedCron: ParsedCronExpression | undefined;
    let everyMs: number | undefined;

    if (definition.cron !== undefined) {
      parsedCron = parseCronExpression(definition.cron);
    } else if (definition.everyMs !== undefined) {
      if (!Number.isInteger(definition.everyMs) || definition.everyMs < 10) {
        throw new QueueValidationError(
          `Schedule "${id}" everyMs must be an integer >= 10`,
        );
      }
      everyMs = definition.everyMs;
    }

    const timezone = validateTimezone(definition.timezone ?? 'UTC');
    const leaseTtlMs = Math.max(100, definition.leaseTtlMs ?? defaultLeaseTtlMs);
    const currentNow = clock();
    const nextRunAt = computeNextSlot(
      {
        ...(parsedCron !== undefined ? { parsedCron } : {}),
        ...(everyMs !== undefined ? { everyMs } : {}),
        timezone,
      },
      currentNow,
    );

    const entry: InternalScheduleEntry = {
      definition: definition as ScheduledJobDefinition<unknown>,
      id,
      jobName,
      ...(parsedCron !== undefined ? { parsedCron } : {}),
      ...(everyMs !== undefined ? { everyMs } : {}),
      timezone,
      leaseTtlMs,
      enabled: definition.enabled ?? true,
      nextRunAt,
      totalRuns: 0,
    };

    schedules.set(id, entry);
    return toPublicInfo(entry);
  }

  if (options.schedules) {
    for (const def of options.schedules) {
      register(def);
    }
  }

  async function executeTick(explicitNowMs?: number): Promise<SchedulerTickResult> {
    const now = explicitNowMs ?? clock();
    let evaluated = 0;
    let enqueued = 0;
    let executedInline = 0;
    let skippedLocked = 0;
    let skippedNotDue = 0;
    const jobs: QueueJob[] = [];
    const tickKeys: string[] = [];

    for (const entry of Array.from(schedules.values())) {
      if (!entry.enabled) {
        continue;
      }
      evaluated += 1;

      if (now < entry.nextRunAt) {
        skippedNotDue += 1;
        continue;
      }

      const slotTimestampMs = entry.nextRunAt;
      // Advance nextRunAt past current `now` so a paused/delayed clock jumps cleanly to the next future slot
      entry.nextRunAt = computeNextSlot(entry, Math.max(now, slotTimestampMs));

      const baseCtx = {
        scheduleId: entry.id,
        jobName: entry.jobName,
        slotTimestampMs,
        timezone: entry.timezone,
        nodeId,
      };
      const rawTickKey = entry.definition.buildTickKey
        ? entry.definition.buildTickKey(baseCtx)
        : `schedule:${entry.id}:${slotTimestampMs}`;
      const tickKey = validateIdempotencyKey(rawTickKey);
      const lockKey = `lock:${tickKey}`;

      try {
        const acquired = await lockAdapter.acquire(lockKey, nodeId, entry.leaseTtlMs, now);
        if (!acquired) {
          skippedLocked += 1;
          continue;
        }

        const tickCtx: ScheduledJobTickContext = {
          ...baseCtx,
          tickKey,
        };

        const rawPayload =
          typeof entry.definition.payload === 'function'
            ? await (
                entry.definition.payload as (ctx: ScheduledJobTickContext) => unknown
              )(tickCtx)
            : (entry.definition.payload ?? {
                scheduleId: entry.id,
                slotTimestampMs,
                tickKey,
              });
        const payload = sanitizePayload(rawPayload);

        let enqueuedJob: QueueJob | undefined;
        if (options.queue) {
          enqueuedJob = await options.queue.enqueue(entry.jobName, payload, {
            ...(entry.definition.enqueueOptions ?? {}),
            idempotencyKey: tickKey,
          });
          jobs.push(enqueuedJob);
          enqueued += 1;
        }

        if (entry.definition.onTick) {
          await entry.definition.onTick(tickCtx, enqueuedJob);
          executedInline += 1;
        }

        entry.lastRunAt = now;
        entry.lastTickKey = tickKey;
        entry.totalRuns += 1;
        tickKeys.push(tickKey);
      } catch (err: unknown) {
        if (options.onError) {
          await options.onError(entry.id, err);
        } else {
          throw err;
        }
      }
    }

    return {
      timestampMs: now,
      evaluated,
      enqueued,
      executedInline,
      skippedLocked,
      skippedNotDue,
      jobs,
      tickKeys,
    };
  }

  return {
    nodeId,

    get running(): boolean {
      return running;
    },

    register,

    unregister(scheduleId: string): boolean {
      return schedules.delete(scheduleId);
    },

    pause(scheduleId: string): boolean {
      const entry = schedules.get(scheduleId);
      if (!entry) return false;
      entry.enabled = false;
      return true;
    },

    resume(scheduleId: string, explicitNowMs?: number): boolean {
      const entry = schedules.get(scheduleId);
      if (!entry) return false;
      entry.enabled = true;
      entry.nextRunAt = computeNextSlot(entry, explicitNowMs ?? clock());
      return true;
    },

    get(scheduleId: string): RegisteredScheduleInfo | undefined {
      const entry = schedules.get(scheduleId);
      return entry ? toPublicInfo(entry) : undefined;
    },

    list(): readonly RegisteredScheduleInfo[] {
      return Array.from(schedules.values()).map((entry) => toPublicInfo(entry));
    },

    async tick(nowMs?: number): Promise<SchedulerTickResult> {
      const promise = executeTick(nowMs);
      activeTickPromise = promise;
      try {
        return await promise;
      } finally {
        if (activeTickPromise === promise) {
          activeTickPromise = null;
        }
      }
    },

    start(): void {
      if (running) return;
      running = true;
      timer = setInterval(() => {
        if (!running || activeTickPromise !== null) return;
        void this.tick().catch(() => {});
      }, tickIntervalMs);
      if (typeof timer === 'object' && timer !== null && 'unref' in timer) {
        (timer as { unref?: () => void }).unref?.();
      }
    },

    async stop(): Promise<void> {
      running = false;
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
      if (activeTickPromise !== null) {
        try {
          await activeTickPromise;
        } catch {
          // Ignore tick errors on stop
        }
      }
    },
  };
}
