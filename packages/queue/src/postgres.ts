import { QueueError, QueueFullError, QueueValidationError } from './errors.js';
import {
  assertPayloadSizeLimit,
  computeBackoffDelayMs,
  sanitizePayload,
  validateIdempotencyKey,
  validateJobName,
} from './sanitize.js';
import type {
  BackoffPolicy,
  EnqueueOptions,
  FailJobOutcome,
  JobStatus,
  PostgresQueueAdapter,
  PostgresQueueOptions,
  PostgresQueueSqlLike,
  QueueJob,
  QueueStats,
} from './types.js';

interface PostgresJobRow {
  readonly id: string;
  readonly name: string;
  readonly payload_json: string;
  readonly status: JobStatus;
  readonly priority: number;
  readonly attempts: number;
  readonly max_attempts: number;
  readonly backoff_json: string | null;
  readonly timeout_ms: number | null;
  readonly idempotency_key: string | null;
  readonly created_at: number | string;
  readonly available_at: number | string;
  readonly started_at: number | string | null;
  readonly completed_at: number | string | null;
  readonly result_json: string | null;
  readonly last_error: string | null;
}

const DEFAULT_BACKOFF: BackoffPolicy = {
  type: 'exponential',
  delayMs: 50,
  maxDelayMs: 10_000,
  jitter: false,
};

const SAFE_IDENTIFIER_REGEX = /^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/;

function assertSafeIdentifier(value: string, label: string): string {
  if (!SAFE_IDENTIFIER_REGEX.test(value)) {
    throw new QueueValidationError(`Invalid SQL ${label} "${value}"`);
  }
  return value;
}

function normalizeRunner(sql: PostgresQueueSqlLike): {
  query<TRow = Record<string, unknown>>(
    text: string,
    params?: readonly unknown[],
  ): Promise<readonly TRow[]>;
  ping?: () => Promise<boolean>;
  end?: () => Promise<void>;
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
      ...(typeof sql.ping === 'function' ? { ping: () => sql.ping!() } : {}),
      ...(typeof sql.end === 'function' ? { end: () => sql.end!() } : {}),
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
      ...(typeof sql.end === 'function' ? { end: () => sql.end!() } : {}),
    };
  }

  throw new QueueValidationError(
    'PostgresQueueSqlLike must implement either query(text, params) or unsafe(text, params)',
  );
}

function rowToJob<TPayload = unknown, TResult = unknown>(
  row: PostgresJobRow,
): QueueJob<TPayload, TResult> {
  const payload = sanitizePayload(JSON.parse(row.payload_json)) as TPayload;
  const backoff =
    row.backoff_json !== null ? (JSON.parse(row.backoff_json) as BackoffPolicy) : undefined;
  const result =
    row.result_json !== null
      ? (sanitizePayload(JSON.parse(row.result_json)) as TResult)
      : undefined;

  return {
    id: row.id,
    name: row.name,
    payload,
    status: row.status,
    priority: Number(row.priority),
    attempts: Number(row.attempts),
    maxAttempts: Number(row.max_attempts),
    ...(backoff !== undefined ? { backoff } : {}),
    ...(row.timeout_ms !== null ? { timeoutMs: Number(row.timeout_ms) } : {}),
    ...(row.idempotency_key !== null ? { idempotencyKey: row.idempotency_key } : {}),
    createdAt: Number(row.created_at),
    availableAt: Number(row.available_at),
    ...(row.started_at !== null ? { startedAt: Number(row.started_at) } : {}),
    ...(row.completed_at !== null ? { completedAt: Number(row.completed_at) } : {}),
    ...(result !== undefined ? { result } : {}),
    ...(row.last_error !== null ? { lastError: row.last_error } : {}),
  };
}

export function createPostgresQueueAdapter(
  sql: PostgresQueueSqlLike,
  options: PostgresQueueOptions = {},
): PostgresQueueAdapter {
  const runner = normalizeRunner(sql);
  const schemaName = assertSafeIdentifier(options.schemaName ?? 'public', 'schemaName');
  const tableName = assertSafeIdentifier(options.tableName ?? 'forge_jobs', 'tableName');
  const qualifiedTable = `"${schemaName}"."${tableName}"`;
  const idxStatusName = assertSafeIdentifier(`${tableName}_status_avail_prio_idx`, 'indexName');
  const idxIdempName = assertSafeIdentifier(`${tableName}_active_idemp_uidx`, 'indexName');

  const maxQueueSize = options.maxQueueSize ?? 100_000;
  const maxPayloadBytes = options.maxPayloadBytes ?? 1_048_576;
  const defaultMaxAttempts = options.defaultMaxAttempts ?? 3;
  const defaultBackoff = options.defaultBackoff ?? DEFAULT_BACKOFF;
  const autoCreateSchema = options.autoCreateSchema ?? true;
  const visibilityTimeoutMs = options.visibilityTimeoutMs ?? 300_000;
  const statsCacheTtlMs = options.statsCacheTtlMs ?? 1_000;
  const now = options.now ?? (() => Date.now());

  if (!Number.isInteger(maxQueueSize) || maxQueueSize < 1) {
    throw new QueueValidationError('maxQueueSize must be a positive integer');
  }
  if (!Number.isFinite(visibilityTimeoutMs) || visibilityTimeoutMs < 1) {
    throw new QueueValidationError('visibilityTimeoutMs must be a positive number');
  }

  let lastStats: QueueStats = {
    waiting: 0,
    delayed: 0,
    active: 0,
    completed: 0,
    dead: 0,
  };
  let lastStatsFetchedAt = -1;

  function adjustLocalStat(from: JobStatus | null, to: JobStatus | null): void {
    const mutable = { ...lastStats };
    if (from !== null && mutable[from] > 0) {
      mutable[from] -= 1;
    }
    if (to !== null) {
      mutable[to] += 1;
    }
    lastStats = mutable;
  }

  async function refreshStats(): Promise<QueueStats> {
    const rows = await runner.query<{ readonly status: JobStatus; readonly cnt: number | string }>(
      `SELECT status, COUNT(*)::int AS cnt FROM ${qualifiedTable} GROUP BY status`,
    );
    let waiting = 0;
    let delayed = 0;
    let active = 0;
    let completed = 0;
    let dead = 0;

    for (const row of rows) {
      const cnt = Number(row.cnt);
      if (row.status === 'waiting') waiting = cnt;
      else if (row.status === 'delayed') delayed = cnt;
      else if (row.status === 'active') active = cnt;
      else if (row.status === 'completed') completed = cnt;
      else if (row.status === 'dead') dead = cnt;
    }

    lastStats = { waiting, delayed, active, completed, dead };
    lastStatsFetchedAt = now();
    return lastStats;
  }

  async function ensureCapacityStats(): Promise<QueueStats> {
    const currentTime = now();
    const activeDepth = lastStats.waiting + lastStats.delayed + lastStats.active;
    if (
      lastStatsFetchedAt < 0 ||
      currentTime - lastStatsFetchedAt >= statsCacheTtlMs ||
      activeDepth >= maxQueueSize * 0.9
    ) {
      return refreshStats();
    }
    return lastStats;
  }

  return {
    driver: 'postgres',

    async ensureSchema(): Promise<void> {
      await runner.query(
        `CREATE TABLE IF NOT EXISTS ${qualifiedTable} (
          seq BIGSERIAL PRIMARY KEY,
          id TEXT NOT NULL UNIQUE,
          name TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          status TEXT NOT NULL,
          priority INTEGER NOT NULL DEFAULT 100,
          attempts INTEGER NOT NULL DEFAULT 0,
          max_attempts INTEGER NOT NULL DEFAULT 3,
          backoff_json TEXT,
          timeout_ms INTEGER,
          idempotency_key TEXT,
          created_at BIGINT NOT NULL,
          available_at BIGINT NOT NULL,
          started_at BIGINT,
          completed_at BIGINT,
          result_json TEXT,
          last_error TEXT
        )`,
      );
      await runner.query(
        `CREATE INDEX IF NOT EXISTS "${idxStatusName}" ON ${qualifiedTable} (status, available_at, priority, seq)`,
      );
      await runner.query(
        `CREATE UNIQUE INDEX IF NOT EXISTS "${idxIdempName}" ON ${qualifiedTable} (idempotency_key) WHERE status IN ('waiting', 'delayed', 'active') AND idempotency_key IS NOT NULL`,
      );
    },

    async connect(): Promise<void> {
      if (autoCreateSchema) {
        await this.ensureSchema();
      }
      await runner.query('SELECT 1');
      await refreshStats();
    },

    async disconnect(): Promise<void> {
      if (typeof runner.end === 'function') {
        await runner.end();
      }
    },

    async ping(): Promise<boolean> {
      try {
        if (runner.ping) {
          return await runner.ping();
        }
        await runner.query('SELECT 1');
        return true;
      } catch {
        return false;
      }
    },

    async enqueue<TPayload = unknown>(
      name: string,
      payload: TPayload,
      enqueueOptions: EnqueueOptions = {},
    ): Promise<QueueJob<TPayload>> {
      const validName = validateJobName(name);
      const sanitized = sanitizePayload(payload);
      assertPayloadSizeLimit(sanitized, maxPayloadBytes);

      const idempotencyKey =
        enqueueOptions.idempotencyKey !== undefined
          ? validateIdempotencyKey(enqueueOptions.idempotencyKey)
          : undefined;

      if (idempotencyKey !== undefined) {
        const existingRows = await runner.query<PostgresJobRow>(
          `SELECT * FROM ${qualifiedTable}
           WHERE idempotency_key = $1 AND status IN ('waiting', 'delayed', 'active')
           LIMIT 1`,
          [idempotencyKey],
        );
        const existing = existingRows[0];
        if (existing) {
          return rowToJob<TPayload>(existing);
        }
      }

      const currentStats = await ensureCapacityStats();
      const activeDepth = currentStats.waiting + currentStats.delayed + currentStats.active;
      if (activeDepth >= maxQueueSize) {
        throw new QueueFullError('Queue has reached maximum pending capacity', {
          maxQueueSize,
        });
      }

      const priority = enqueueOptions.priority ?? 100;
      if (!Number.isFinite(priority)) {
        throw new QueueValidationError('priority must be a finite number');
      }

      const maxAttempts = enqueueOptions.maxAttempts ?? defaultMaxAttempts;
      if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
        throw new QueueValidationError('maxAttempts must be a positive integer');
      }

      const delayMs = enqueueOptions.delayMs ?? 0;
      if (!Number.isFinite(delayMs) || delayMs < 0) {
        throw new QueueValidationError('delayMs must be a non-negative finite number');
      }

      const currentTime = now();
      const id = globalThis.crypto.randomUUID();
      const initialStatus: JobStatus = delayMs > 0 ? 'delayed' : 'waiting';
      const availableAt = currentTime + delayMs;
      const backoff = enqueueOptions.backoff ?? defaultBackoff;

      const inserted = await runner.query<PostgresJobRow>(
        `INSERT INTO ${qualifiedTable} (
          id, name, payload_json, status, priority, attempts, max_attempts,
          backoff_json, timeout_ms, idempotency_key, created_at, available_at
        ) VALUES ($1, $2, $3, $4, $5, 0, $6, $7, $8, $9, $10, $11)
        RETURNING *`,
        [
          id,
          validName,
          JSON.stringify(sanitized),
          initialStatus,
          priority,
          maxAttempts,
          JSON.stringify(backoff),
          enqueueOptions.timeoutMs ?? null,
          idempotencyKey ?? null,
          currentTime,
          availableAt,
        ],
      );

      const row = inserted[0];
      if (!row) {
        throw new QueueError('PostgreSQL queue failed to return inserted job row');
      }
      adjustLocalStat(null, initialStatus);
      return rowToJob<TPayload>(row);
    },

    async dequeue(): Promise<QueueJob | undefined> {
      const currentTime = now();
      const rows = await runner.query<PostgresJobRow>(
        `WITH next_job AS (
          SELECT id FROM ${qualifiedTable}
          WHERE (status = 'waiting' OR (status = 'delayed' AND available_at <= $1))
            AND available_at <= $1
          ORDER BY priority ASC, seq ASC
          FOR UPDATE SKIP LOCKED
          LIMIT 1
        )
        UPDATE ${qualifiedTable} AS target
        SET status = 'active',
            attempts = target.attempts + 1,
            started_at = $1
        FROM next_job
        WHERE target.id = next_job.id
        RETURNING target.*`,
        [currentTime],
      );

      const row = rows[0];
      if (row) {
        adjustLocalStat('waiting', 'active');
        return rowToJob(row);
      }
      return undefined;
    },

    async complete<TResult = unknown>(jobId: string, result?: TResult): Promise<QueueJob> {
      const currentTime = now();
      const serializedResult = result !== undefined ? JSON.stringify(sanitizePayload(result)) : null;

      const rows = await runner.query<PostgresJobRow>(
        `UPDATE ${qualifiedTable}
         SET status = 'completed',
             completed_at = $2,
             result_json = $3
         WHERE id = $1
         RETURNING *`,
        [jobId, currentTime, serializedResult],
      );

      const row = rows[0];
      if (!row) {
        throw new QueueError(`Unknown job "${jobId}"`, { statusCode: 404, expose: true });
      }
      adjustLocalStat('active', 'completed');
      return rowToJob(row);
    },

    async fail(jobId: string, error: unknown): Promise<FailJobOutcome> {
      const existing = await this.getJob(jobId);
      if (!existing) {
        throw new QueueError(`Unknown job "${jobId}"`, { statusCode: 404, expose: true });
      }

      const currentTime = now();
      const errorMessage = error instanceof Error ? error.message : String(error);

      if (existing.attempts < existing.maxAttempts) {
        const policy = existing.backoff ?? defaultBackoff;
        const retryDelay = computeBackoffDelayMs(policy, existing.attempts);
        const nextAvailableAt = currentTime + retryDelay;

        const rows = await runner.query<PostgresJobRow>(
          `UPDATE ${qualifiedTable}
           SET status = 'delayed',
               available_at = $2,
               last_error = $3
           WHERE id = $1
           RETURNING *`,
          [jobId, nextAvailableAt, errorMessage],
        );
        adjustLocalStat(existing.status, 'delayed');
        return { status: 'delayed', job: rowToJob(rows[0]!) };
      }

      const rows = await runner.query<PostgresJobRow>(
        `UPDATE ${qualifiedTable}
         SET status = 'dead',
             completed_at = $2,
             last_error = $3
         WHERE id = $1
         RETURNING *`,
        [jobId, currentTime, errorMessage],
      );
      adjustLocalStat(existing.status, 'dead');
      return { status: 'dead', job: rowToJob(rows[0]!) };
    },

    async getJob<TPayload = unknown, TResult = unknown>(
      jobId: string,
    ): Promise<QueueJob<TPayload, TResult> | undefined> {
      const rows = await runner.query<PostgresJobRow>(
        `SELECT * FROM ${qualifiedTable} WHERE id = $1 LIMIT 1`,
        [jobId],
      );
      const row = rows[0];
      return row ? rowToJob<TPayload, TResult>(row) : undefined;
    },

    async getDeadLetters(): Promise<readonly QueueJob[]> {
      const rows = await runner.query<PostgresJobRow>(
        `SELECT * FROM ${qualifiedTable} WHERE status = 'dead' ORDER BY completed_at ASC`,
      );
      return rows.map((row) => rowToJob(row));
    },

    async replayDeadLetter(jobId: string): Promise<QueueJob> {
      const existing = await this.getJob(jobId);
      if (!existing) {
        throw new QueueError(`Dead-letter job "${jobId}" not found`, {
          statusCode: 404,
          expose: true,
        });
      }
      if (existing.status !== 'dead') {
        throw new QueueValidationError(`Job "${jobId}" is in "${existing.status}" state, not "dead"`);
      }

      const currentTime = now();
      const rows = await runner.query<PostgresJobRow>(
        `UPDATE ${qualifiedTable}
         SET status = 'waiting',
             attempts = 0,
             available_at = $2,
             started_at = NULL,
             completed_at = NULL
         WHERE id = $1
         RETURNING *`,
        [jobId, currentTime],
      );
      adjustLocalStat('dead', 'waiting');
      return rowToJob(rows[0]!);
    },

    async reclaimStaleJobs(maxAgeMs = visibilityTimeoutMs): Promise<number> {
      if (!Number.isFinite(maxAgeMs) || maxAgeMs < 1) {
        throw new QueueValidationError('visibilityTimeoutMs must be a positive number');
      }
      const currentTime = now();
      const cutoff = currentTime - maxAgeMs;
      const rows = await runner.query<{ readonly id: string }>(
        `WITH stale AS (
          SELECT id, attempts, max_attempts
          FROM ${qualifiedTable}
          WHERE status = 'active'
            AND started_at IS NOT NULL
            AND started_at <= $1
          FOR UPDATE SKIP LOCKED
        )
        UPDATE ${qualifiedTable} AS target
        SET status = CASE WHEN stale.attempts < stale.max_attempts THEN 'waiting' ELSE 'dead' END,
            available_at = CASE WHEN stale.attempts < stale.max_attempts THEN $2 ELSE target.available_at END,
            started_at = CASE WHEN stale.attempts < stale.max_attempts THEN NULL ELSE target.started_at END,
            completed_at = CASE WHEN stale.attempts < stale.max_attempts THEN NULL ELSE $2 END,
            last_error = COALESCE(target.last_error, 'Job exceeded visibility timeout')
        FROM stale
        WHERE target.id = stale.id
        RETURNING target.id`,
        [cutoff, currentTime],
      );
      if (rows.length > 0) {
        lastStatsFetchedAt = -1;
      }
      return rows.length;
    },

    async purge(status?: JobStatus): Promise<number> {
      const rows =
        status !== undefined
          ? await runner.query<{ readonly id: string }>(
              `DELETE FROM ${qualifiedTable} WHERE status = $1 RETURNING id`,
              [status],
            )
          : await runner.query<{ readonly id: string }>(`DELETE FROM ${qualifiedTable} RETURNING id`);

      await refreshStats();
      return rows.length;
    },

    stats(): QueueStats {
      return lastStats;
    },

    async fetchStats(): Promise<QueueStats> {
      return refreshStats();
    },
  };
}
