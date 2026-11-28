import type { EventDispatcher } from '@forge-fr/core';
import { QueueError, QueueValidationError } from './errors.js';
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
  PostgresQueueSqlLike,
  QueueAdapter,
  QueueJob,
} from './types.js';

export type OutboxStatus = 'pending' | 'processing' | 'published' | 'dead';

export interface OutboxRecord<TPayload = unknown> {
  readonly id: string;
  readonly topic: string;
  readonly payload: TPayload;
  readonly status: OutboxStatus;
  readonly priority: number;
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly backoff?: BackoffPolicy;
  readonly timeoutMs?: number;
  readonly idempotencyKey?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly createdAt: number;
  readonly availableAt: number;
  readonly claimedAt?: number;
  readonly publishedAt?: number;
  readonly lastError?: string;
}

export interface OutboxStats {
  readonly pending: number;
  readonly processing: number;
  readonly published: number;
  readonly dead: number;
}

/**
 * Structural transaction context compatible with `@forge-fr/database` `TransactionContext<TTx>`,
 * Drizzle/Prisma transaction clients, or `PostgresQueueSqlLike`.
 */
export interface OutboxTransactionContextLike {
  readonly tx?: unknown;
  afterCommit?(hook: () => void | Promise<void>): void;
  afterRollback?(hook: () => void | Promise<void>): void;
  query?<TRow = Record<string, unknown>>(
    text: string,
    params?: readonly unknown[],
  ): Promise<{ readonly rows: readonly TRow[] }>;
  unsafe?<TRow = Record<string, unknown>>(
    text: string,
    params?: readonly unknown[],
  ): Promise<readonly TRow[]>;
  $queryRawUnsafe?<TRow = Record<string, unknown>>(
    text: string,
    ...params: unknown[]
  ): Promise<readonly TRow[]>;
}

export type OutboxTransactionHandle = PostgresQueueSqlLike | OutboxTransactionContextLike;

export interface OutboxEnqueueOptions extends EnqueueOptions {
  /**
   * Optional transaction context (`TransactionContext` from `@forge-fr/database` `UnitOfWork`,
   * or a `PostgresQueueSqlLike` SQL transaction client) to atomically bind this outbox write
   * to the surrounding database transaction.
   */
  readonly tx?: OutboxTransactionHandle;
  /** Optional metadata headers persisted alongside the outbox event. */
  readonly headers?: Readonly<Record<string, string>>;
}

export interface OutboxBatchEntry<TPayload = unknown> {
  readonly topic: string;
  readonly payload: TPayload;
  readonly options?: Omit<OutboxEnqueueOptions, 'tx'>;
}

export interface OutboxStoreInsertInput<TPayload = unknown> {
  readonly id: string;
  readonly topic: string;
  readonly payload: TPayload;
  readonly priority: number;
  readonly maxAttempts: number;
  readonly backoff?: BackoffPolicy;
  readonly timeoutMs?: number;
  readonly idempotencyKey?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly createdAt: number;
  readonly availableAt: number;
}

export interface OutboxStoreAdapter {
  readonly driver: 'memory' | 'postgres' | 'custom';
  ensureSchema(): Promise<void>;
  insert<TPayload = unknown>(
    entry: OutboxStoreInsertInput<TPayload>,
    tx?: OutboxTransactionHandle,
  ): Promise<OutboxRecord<TPayload>>;
  claimBatch(limit: number, nowMs: number): Promise<readonly OutboxRecord[]>;
  markPublished(id: string, nowMs: number): Promise<OutboxRecord>;
  markFailed(
    id: string,
    error: unknown,
    nowMs: number,
    defaultBackoff: BackoffPolicy,
  ): Promise<{ readonly status: 'pending' | 'dead'; readonly record: OutboxRecord }>;
  getRecord<TPayload = unknown>(id: string): Promise<OutboxRecord<TPayload> | undefined>;
  getDeadLetters(): Promise<readonly OutboxRecord[]>;
  replayDeadLetter(id: string, nowMs: number): Promise<OutboxRecord>;
  reclaimStaleProcessing(maxAgeMs: number, nowMs: number): Promise<number>;
  purgePublished(olderThanMs?: number, nowMs?: number): Promise<number>;
  stats(): Promise<OutboxStats>;
}

const DEFAULT_OUTBOX_BACKOFF: BackoffPolicy = Object.freeze({
  type: 'exponential',
  delayMs: 100,
  maxDelayMs: 30_000,
  jitter: false,
});

const SAFE_IDENTIFIER_REGEX = /^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/;

function assertSafeIdentifier(value: string, label: string): string {
  if (!SAFE_IDENTIFIER_REGEX.test(value)) {
    throw new QueueValidationError(`Invalid SQL ${label} "${value}"`);
  }
  return value;
}

function cloneRecord<TPayload>(rec: OutboxRecord<TPayload>): OutboxRecord<TPayload> {
  return Object.freeze({
    ...rec,
    payload: sanitizePayload(rec.payload),
    ...(rec.backoff !== undefined ? { backoff: { ...rec.backoff } } : {}),
    ...(rec.headers !== undefined ? { headers: Object.freeze({ ...rec.headers }) } : {}),
  });
}

function isTransactionContextWithHooks(
  tx: unknown,
): tx is {
  readonly tx?: unknown;
  afterCommit: (hook: () => void | Promise<void>) => void;
  afterRollback?: (hook: () => void | Promise<void>) => void;
} {
  return (
    typeof tx === 'object' &&
    tx !== null &&
    'afterCommit' in tx &&
    typeof (tx as { afterCommit?: unknown }).afterCommit === 'function'
  );
}

export interface MemoryOutboxStoreOptions {
  readonly now?: () => number;
}

export interface MemoryOutboxStore extends OutboxStoreAdapter {
  readonly driver: 'memory';
  clear(): void;
}

/**
 * In-memory `OutboxStoreAdapter` with full support for `@forge-fr/database` `TransactionContext`
 * (`afterCommit` / `afterRollback`) so unit tests and in-memory `UnitOfWork` transactions accurately
 * commit or discard staged outbox records on rollback.
 */
export function createMemoryOutboxStore(
  options: MemoryOutboxStoreOptions = {},
): MemoryOutboxStore {
  const clock = options.now ?? (() => Date.now());
  const records = new Map<string, OutboxRecord>();
  const activeIdempotency = new Map<string, string>();

  function commitRecord<TPayload>(record: OutboxRecord<TPayload>): OutboxRecord<TPayload> {
    if (record.idempotencyKey !== undefined) {
      const existingId = activeIdempotency.get(record.idempotencyKey);
      if (existingId !== undefined) {
        const existing = records.get(existingId);
        if (existing && existing.status !== 'dead') {
          return cloneRecord(existing as OutboxRecord<TPayload>);
        }
      }
      activeIdempotency.set(record.idempotencyKey, record.id);
    }
    records.set(record.id, record);
    return cloneRecord(record);
  }

  return {
    driver: 'memory',

    async ensureSchema(): Promise<void> {
      // No-op for memory store
    },

    async insert<TPayload = unknown>(
      entry: OutboxStoreInsertInput<TPayload>,
      tx?: OutboxTransactionHandle,
    ): Promise<OutboxRecord<TPayload>> {
      if (entry.idempotencyKey !== undefined && !isTransactionContextWithHooks(tx)) {
        const existingId = activeIdempotency.get(entry.idempotencyKey);
        if (existingId !== undefined) {
          const existing = records.get(existingId);
          if (existing && existing.status !== 'dead') {
            return cloneRecord(existing as OutboxRecord<TPayload>);
          }
        }
      }

      const record: OutboxRecord<TPayload> = Object.freeze({
        id: entry.id,
        topic: entry.topic,
        payload: sanitizePayload(entry.payload),
        status: 'pending',
        priority: entry.priority,
        attempts: 0,
        maxAttempts: entry.maxAttempts,
        ...(entry.backoff !== undefined ? { backoff: entry.backoff } : {}),
        ...(entry.timeoutMs !== undefined ? { timeoutMs: entry.timeoutMs } : {}),
        ...(entry.idempotencyKey !== undefined ? { idempotencyKey: entry.idempotencyKey } : {}),
        ...(entry.headers !== undefined ? { headers: Object.freeze({ ...entry.headers }) } : {}),
        createdAt: entry.createdAt,
        availableAt: entry.availableAt,
      });

      // If a TransactionContext with afterCommit/afterRollback hooks is provided, stage until commit!
      if (isTransactionContextWithHooks(tx)) {
        let discarded = false;
        tx.afterRollback?.(() => {
          discarded = true;
        });
        tx.afterCommit(() => {
          if (!discarded) {
            commitRecord(record);
          }
        });
        return cloneRecord(record);
      }

      return commitRecord(record);
    },

    async claimBatch(limit: number, nowMs = clock()): Promise<readonly OutboxRecord[]> {
      const candidates = Array.from(records.values())
        .filter((r) => r.status === 'pending' && r.availableAt <= nowMs)
        .sort((a, b) => {
          if (a.priority !== b.priority) return a.priority - b.priority;
          return a.createdAt - b.createdAt;
        })
        .slice(0, Math.max(1, limit));

      const claimed: OutboxRecord[] = [];
      for (const rec of candidates) {
        const updated: OutboxRecord = Object.freeze({
          ...rec,
          status: 'processing',
          attempts: rec.attempts + 1,
          claimedAt: nowMs,
        });
        records.set(rec.id, updated);
        claimed.push(cloneRecord(updated));
      }
      return claimed;
    },

    async markPublished(id: string, nowMs = clock()): Promise<OutboxRecord> {
      const existing = records.get(id);
      if (!existing) {
        throw new QueueError(`Unknown outbox record "${id}"`, { statusCode: 404, expose: true });
      }
      const updated: OutboxRecord = Object.freeze({
        ...existing,
        status: 'published',
        publishedAt: nowMs,
      });
      records.set(id, updated);
      return cloneRecord(updated);
    },

    async markFailed(
      id: string,
      error: unknown,
      nowMs = clock(),
      defaultBackoff = DEFAULT_OUTBOX_BACKOFF,
    ): Promise<{ readonly status: 'pending' | 'dead'; readonly record: OutboxRecord }> {
      const existing = records.get(id);
      if (!existing) {
        throw new QueueError(`Unknown outbox record "${id}"`, { statusCode: 404, expose: true });
      }
      const errorMessage = error instanceof Error ? error.message : String(error);

      if (existing.attempts < existing.maxAttempts) {
        const policy = existing.backoff ?? defaultBackoff;
        const delayMs = computeBackoffDelayMs(policy, existing.attempts);
        const updated: OutboxRecord = Object.freeze({
          ...existing,
          status: 'pending',
          availableAt: nowMs + delayMs,
          lastError: errorMessage,
        });
        records.set(id, updated);
        return { status: 'pending', record: cloneRecord(updated) };
      }

      const deadRecord: OutboxRecord = Object.freeze({
        ...existing,
        status: 'dead',
        lastError: errorMessage,
      });
      records.set(id, deadRecord);
      if (existing.idempotencyKey !== undefined) {
        activeIdempotency.delete(existing.idempotencyKey);
      }
      return { status: 'dead', record: cloneRecord(deadRecord) };
    },

    async getRecord<TPayload = unknown>(id: string): Promise<OutboxRecord<TPayload> | undefined> {
      const rec = records.get(id);
      return rec ? cloneRecord(rec as OutboxRecord<TPayload>) : undefined;
    },

    async getDeadLetters(): Promise<readonly OutboxRecord[]> {
      return Array.from(records.values())
        .filter((r) => r.status === 'dead')
        .map((r) => cloneRecord(r));
    },

    async replayDeadLetter(id: string, nowMs = clock()): Promise<OutboxRecord> {
      const existing = records.get(id);
      if (!existing) {
        throw new QueueError(`Dead-letter outbox record "${id}" not found`, {
          statusCode: 404,
          expose: true,
        });
      }
      if (existing.status !== 'dead') {
        throw new QueueValidationError(
          `Outbox record "${id}" is in "${existing.status}" state, not "dead"`,
        );
      }
      const updated: OutboxRecord = Object.freeze({
        ...existing,
        status: 'pending',
        attempts: 0,
        availableAt: nowMs,
      });
      records.set(id, updated);
      if (updated.idempotencyKey !== undefined) {
        activeIdempotency.set(updated.idempotencyKey, updated.id);
      }
      return cloneRecord(updated);
    },

    async reclaimStaleProcessing(maxAgeMs: number, nowMs = clock()): Promise<number> {
      const cutoff = nowMs - Math.max(1, maxAgeMs);
      let count = 0;
      for (const rec of Array.from(records.values())) {
        if (rec.status === 'processing' && (rec.claimedAt ?? rec.createdAt) <= cutoff) {
          count += 1;
          const nextStatus: OutboxStatus = rec.attempts < rec.maxAttempts ? 'pending' : 'dead';
          records.set(
            rec.id,
            Object.freeze({
              ...rec,
              status: nextStatus,
              availableAt: nowMs,
              lastError: rec.lastError ?? 'Outbox relay exceeded processing visibility timeout',
            }),
          );
        }
      }
      return count;
    },

    async purgePublished(olderThanMs = 0, nowMs = clock()): Promise<number> {
      const cutoff = nowMs - Math.max(0, olderThanMs);
      let purged = 0;
      for (const [id, rec] of Array.from(records.entries())) {
        if (rec.status === 'published' && (rec.publishedAt ?? rec.createdAt) <= cutoff) {
          records.delete(id);
          if (rec.idempotencyKey !== undefined) {
            activeIdempotency.delete(rec.idempotencyKey);
          }
          purged += 1;
        }
      }
      return purged;
    },

    async stats(): Promise<OutboxStats> {
      let pending = 0;
      let processing = 0;
      let published = 0;
      let dead = 0;
      for (const rec of records.values()) {
        if (rec.status === 'pending') pending += 1;
        else if (rec.status === 'processing') processing += 1;
        else if (rec.status === 'published') published += 1;
        else if (rec.status === 'dead') dead += 1;
      }
      return { pending, processing, published, dead };
    },

    clear(): void {
      records.clear();
      activeIdempotency.clear();
    },
  };
}

interface PostgresOutboxRow {
  readonly id: string;
  readonly topic: string;
  readonly payload_json: string;
  readonly status: OutboxStatus;
  readonly priority: number;
  readonly attempts: number;
  readonly max_attempts: number;
  readonly backoff_json: string | null;
  readonly timeout_ms: number | null;
  readonly idempotency_key: string | null;
  readonly headers_json: string | null;
  readonly created_at: number | string;
  readonly available_at: number | string;
  readonly claimed_at: number | string | null;
  readonly published_at: number | string | null;
  readonly last_error: string | null;
}

interface NormalizedSqlRunner {
  query<TRow = Record<string, unknown>>(
    text: string,
    params?: readonly unknown[],
  ): Promise<readonly TRow[]>;
}

function tryExtractSqlRunner(candidate: unknown): NormalizedSqlRunner | null {
  if (typeof candidate !== 'object' || candidate === null) {
    return null;
  }

  // Unwrap UnitOfWork TransactionContext `.tx` if present
  if ('tx' in candidate && (candidate as { tx?: unknown }).tx !== undefined) {
    const inner = tryExtractSqlRunner((candidate as { tx?: unknown }).tx);
    if (inner !== null) {
      return inner;
    }
  }

  if ('query' in candidate && typeof (candidate as { query?: unknown }).query === 'function') {
    const q = candidate as {
      query<TRow>(text: string, params?: readonly unknown[]): Promise<{ readonly rows: readonly TRow[] }>;
    };
    return {
      query: async <TRow = Record<string, unknown>>(
        text: string,
        params: readonly unknown[] = [],
      ): Promise<readonly TRow[]> => {
        const res = await q.query<TRow>(text, params);
        return res.rows;
      },
    };
  }

  if ('unsafe' in candidate && typeof (candidate as { unsafe?: unknown }).unsafe === 'function') {
    const u = candidate as {
      unsafe<TRow>(text: string, params?: readonly unknown[]): Promise<readonly TRow[]>;
    };
    return {
      query: async <TRow = Record<string, unknown>>(
        text: string,
        params: readonly unknown[] = [],
      ): Promise<readonly TRow[]> => {
        return await u.unsafe<TRow>(text, params);
      },
    };
  }

  if (
    '$queryRawUnsafe' in candidate &&
    typeof (candidate as { $queryRawUnsafe?: unknown }).$queryRawUnsafe === 'function'
  ) {
    const p = candidate as {
      $queryRawUnsafe<TRow>(text: string, ...params: unknown[]): Promise<readonly TRow[]>;
    };
    return {
      query: async <TRow = Record<string, unknown>>(
        text: string,
        params: readonly unknown[] = [],
      ): Promise<readonly TRow[]> => {
        return await p.$queryRawUnsafe<TRow>(text, ...params);
      },
    };
  }

  return null;
}

function requireSqlRunner(sql: PostgresQueueSqlLike): NormalizedSqlRunner {
  const runner = tryExtractSqlRunner(sql);
  if (!runner) {
    throw new QueueValidationError(
      'PostgresQueueSqlLike must implement either query(text, params) or unsafe(text, params)',
    );
  }
  return runner;
}

function rowToOutboxRecord<TPayload = unknown>(row: PostgresOutboxRow): OutboxRecord<TPayload> {
  const payload = sanitizePayload(JSON.parse(row.payload_json)) as TPayload;
  const backoff =
    row.backoff_json !== null ? (JSON.parse(row.backoff_json) as BackoffPolicy) : undefined;
  const headers =
    row.headers_json !== null
      ? (Object.freeze(JSON.parse(row.headers_json)) as Readonly<Record<string, string>>)
      : undefined;

  return Object.freeze({
    id: row.id,
    topic: row.topic,
    payload,
    status: row.status,
    priority: Number(row.priority),
    attempts: Number(row.attempts),
    maxAttempts: Number(row.max_attempts),
    ...(backoff !== undefined ? { backoff } : {}),
    ...(row.timeout_ms !== null ? { timeoutMs: Number(row.timeout_ms) } : {}),
    ...(row.idempotency_key !== null ? { idempotencyKey: row.idempotency_key } : {}),
    ...(headers !== undefined ? { headers } : {}),
    createdAt: Number(row.created_at),
    availableAt: Number(row.available_at),
    ...(row.claimed_at !== null ? { claimedAt: Number(row.claimed_at) } : {}),
    ...(row.published_at !== null ? { publishedAt: Number(row.published_at) } : {}),
    ...(row.last_error !== null ? { lastError: row.last_error } : {}),
  });
}

export interface PostgresOutboxStoreOptions {
  /** SQL table name (validated against `[a-zA-Z_][a-zA-Z0-9_]*`). Default: `'forge_outbox'`. */
  readonly tableName?: string;
  /** PostgreSQL schema name. Default: `'public'`. */
  readonly schemaName?: string;
}

/**
 * PostgreSQL-backed `OutboxStoreAdapter`.
 * When `tx` (a `TransactionContext` from `@forge-fr/database` `UnitOfWork`, Drizzle/Prisma tx, or `PostgresQueueSqlLike`)
 * is passed to `insert(entry, tx)`, the `INSERT` statement executes on that transaction connection so a database
 * rollback atomically rolls back the outbox event.
 */
export function createPostgresOutboxStore(
  sql: PostgresQueueSqlLike,
  options: PostgresOutboxStoreOptions = {},
): OutboxStoreAdapter {
  const defaultRunner = requireSqlRunner(sql);
  const schemaName = assertSafeIdentifier(options.schemaName ?? 'public', 'schemaName');
  const tableName = assertSafeIdentifier(options.tableName ?? 'forge_outbox', 'tableName');
  const qualifiedTable = `"${schemaName}"."${tableName}"`;
  const idxPendingName = assertSafeIdentifier(`${tableName}_status_avail_prio_idx`, 'indexName');
  const idxIdempName = assertSafeIdentifier(`${tableName}_idemp_uidx`, 'indexName');

  return {
    driver: 'postgres',

    async ensureSchema(): Promise<void> {
      await defaultRunner.query(
        `CREATE TABLE IF NOT EXISTS ${qualifiedTable} (
          seq BIGSERIAL PRIMARY KEY,
          id TEXT NOT NULL UNIQUE,
          topic TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          status TEXT NOT NULL,
          priority INTEGER NOT NULL DEFAULT 100,
          attempts INTEGER NOT NULL DEFAULT 0,
          max_attempts INTEGER NOT NULL DEFAULT 5,
          backoff_json TEXT,
          timeout_ms INTEGER,
          idempotency_key TEXT,
          headers_json TEXT,
          created_at BIGINT NOT NULL,
          available_at BIGINT NOT NULL,
          claimed_at BIGINT,
          published_at BIGINT,
          last_error TEXT
        )`,
      );
      await defaultRunner.query(
        `CREATE INDEX IF NOT EXISTS "${idxPendingName}" ON ${qualifiedTable} (status, available_at, priority, seq)`,
      );
      await defaultRunner.query(
        `CREATE UNIQUE INDEX IF NOT EXISTS "${idxIdempName}" ON ${qualifiedTable} (idempotency_key) WHERE status IN ('pending', 'processing', 'published') AND idempotency_key IS NOT NULL`,
      );
    },

    async insert<TPayload = unknown>(
      entry: OutboxStoreInsertInput<TPayload>,
      tx?: OutboxTransactionHandle,
    ): Promise<OutboxRecord<TPayload>> {
      const txRunner = tx !== undefined ? tryExtractSqlRunner(tx) : null;
      const activeRunner = txRunner ?? defaultRunner;

      // If tx is a TransactionContext with afterCommit hooks but NO direct SQL runner, defer insert to afterCommit
      if (tx !== undefined && txRunner === null && isTransactionContextWithHooks(tx)) {
        const preview: OutboxRecord<TPayload> = Object.freeze({
          id: entry.id,
          topic: entry.topic,
          payload: sanitizePayload(entry.payload),
          status: 'pending',
          priority: entry.priority,
          attempts: 0,
          maxAttempts: entry.maxAttempts,
          ...(entry.backoff !== undefined ? { backoff: entry.backoff } : {}),
          ...(entry.timeoutMs !== undefined ? { timeoutMs: entry.timeoutMs } : {}),
          ...(entry.idempotencyKey !== undefined ? { idempotencyKey: entry.idempotencyKey } : {}),
          ...(entry.headers !== undefined ? { headers: Object.freeze({ ...entry.headers }) } : {}),
          createdAt: entry.createdAt,
          availableAt: entry.availableAt,
        });
        let rolledBack = false;
        tx.afterRollback?.(() => {
          rolledBack = true;
        });
        tx.afterCommit(async () => {
          if (!rolledBack) {
            await this.insert(entry);
          }
        });
        return preview;
      }

      if (entry.idempotencyKey !== undefined) {
        const existingRows = await activeRunner.query<PostgresOutboxRow>(
          `SELECT * FROM ${qualifiedTable}
           WHERE idempotency_key = $1 AND status IN ('pending', 'processing', 'published')
           LIMIT 1`,
          [entry.idempotencyKey],
        );
        if (existingRows[0]) {
          return rowToOutboxRecord<TPayload>(existingRows[0]);
        }
      }

      const inserted = await activeRunner.query<PostgresOutboxRow>(
        `INSERT INTO ${qualifiedTable} (
          id, topic, payload_json, status, priority, attempts, max_attempts,
          backoff_json, timeout_ms, idempotency_key, headers_json, created_at, available_at
        ) VALUES ($1, $2, $3, 'pending', $4, 0, $5, $6, $7, $8, $9, $10, $11)
        RETURNING *`,
        [
          entry.id,
          entry.topic,
          JSON.stringify(entry.payload),
          entry.priority,
          entry.maxAttempts,
          entry.backoff !== undefined ? JSON.stringify(entry.backoff) : null,
          entry.timeoutMs ?? null,
          entry.idempotencyKey ?? null,
          entry.headers !== undefined ? JSON.stringify(entry.headers) : null,
          entry.createdAt,
          entry.availableAt,
        ],
      );

      const row = inserted[0];
      if (!row) {
        throw new QueueError('PostgreSQL outbox failed to return inserted record');
      }
      return rowToOutboxRecord<TPayload>(row);
    },

    async claimBatch(limit: number, nowMs: number): Promise<readonly OutboxRecord[]> {
      const safeLimit = Math.max(1, Math.min(1000, Math.floor(limit)));
      const rows = await defaultRunner.query<PostgresOutboxRow>(
        `WITH next_batch AS (
          SELECT id FROM ${qualifiedTable}
          WHERE status = 'pending'
            AND available_at <= $1
          ORDER BY priority ASC, seq ASC
          FOR UPDATE SKIP LOCKED
          LIMIT $2
        )
        UPDATE ${qualifiedTable} AS target
        SET status = 'processing',
            attempts = target.attempts + 1,
            claimed_at = $1
        FROM next_batch
        WHERE target.id = next_batch.id
        RETURNING target.*`,
        [nowMs, safeLimit],
      );
      return rows.map((r) => rowToOutboxRecord(r));
    },

    async markPublished(id: string, nowMs: number): Promise<OutboxRecord> {
      const rows = await defaultRunner.query<PostgresOutboxRow>(
        `UPDATE ${qualifiedTable}
         SET status = 'published',
             published_at = $2
         WHERE id = $1
         RETURNING *`,
        [id, nowMs],
      );
      const row = rows[0];
      if (!row) {
        throw new QueueError(`Unknown outbox record "${id}"`, { statusCode: 404, expose: true });
      }
      return rowToOutboxRecord(row);
    },

    async markFailed(
      id: string,
      error: unknown,
      nowMs: number,
      defaultBackoff: BackoffPolicy,
    ): Promise<{ readonly status: 'pending' | 'dead'; readonly record: OutboxRecord }> {
      const existing = await this.getRecord(id);
      if (!existing) {
        throw new QueueError(`Unknown outbox record "${id}"`, { statusCode: 404, expose: true });
      }
      const errorMessage = error instanceof Error ? error.message : String(error);

      if (existing.attempts < existing.maxAttempts) {
        const policy = existing.backoff ?? defaultBackoff;
        const retryDelay = computeBackoffDelayMs(policy, existing.attempts);
        const nextAvailableAt = nowMs + retryDelay;
        const rows = await defaultRunner.query<PostgresOutboxRow>(
          `UPDATE ${qualifiedTable}
           SET status = 'pending',
               available_at = $2,
               last_error = $3
           WHERE id = $1
           RETURNING *`,
          [id, nextAvailableAt, errorMessage],
        );
        return { status: 'pending', record: rowToOutboxRecord(rows[0]!) };
      }

      const rows = await defaultRunner.query<PostgresOutboxRow>(
        `UPDATE ${qualifiedTable}
         SET status = 'dead',
             last_error = $2
         WHERE id = $1
         RETURNING *`,
        [id, errorMessage],
      );
      return { status: 'dead', record: rowToOutboxRecord(rows[0]!) };
    },

    async getRecord<TPayload = unknown>(id: string): Promise<OutboxRecord<TPayload> | undefined> {
      const rows = await defaultRunner.query<PostgresOutboxRow>(
        `SELECT * FROM ${qualifiedTable} WHERE id = $1 LIMIT 1`,
        [id],
      );
      return rows[0] ? rowToOutboxRecord<TPayload>(rows[0]) : undefined;
    },

    async getDeadLetters(): Promise<readonly OutboxRecord[]> {
      const rows = await defaultRunner.query<PostgresOutboxRow>(
        `SELECT * FROM ${qualifiedTable} WHERE status = 'dead' ORDER BY created_at ASC`,
      );
      return rows.map((r) => rowToOutboxRecord(r));
    },

    async replayDeadLetter(id: string, nowMs: number): Promise<OutboxRecord> {
      const existing = await this.getRecord(id);
      if (!existing) {
        throw new QueueError(`Dead-letter outbox record "${id}" not found`, {
          statusCode: 404,
          expose: true,
        });
      }
      if (existing.status !== 'dead') {
        throw new QueueValidationError(
          `Outbox record "${id}" is in "${existing.status}" state, not "dead"`,
        );
      }
      const rows = await defaultRunner.query<PostgresOutboxRow>(
        `UPDATE ${qualifiedTable}
         SET status = 'pending',
             attempts = 0,
             available_at = $2,
             claimed_at = NULL
         WHERE id = $1
         RETURNING *`,
        [id, nowMs],
      );
      return rowToOutboxRecord(rows[0]!);
    },

    async reclaimStaleProcessing(maxAgeMs: number, nowMs: number): Promise<number> {
      const cutoff = nowMs - Math.max(1, maxAgeMs);
      const rows = await defaultRunner.query<{ readonly id: string }>(
        `WITH stale AS (
          SELECT id, attempts, max_attempts
          FROM ${qualifiedTable}
          WHERE status = 'processing'
            AND claimed_at IS NOT NULL
            AND claimed_at <= $1
          FOR UPDATE SKIP LOCKED
        )
        UPDATE ${qualifiedTable} AS target
        SET status = CASE WHEN stale.attempts < stale.max_attempts THEN 'pending' ELSE 'dead' END,
            available_at = CASE WHEN stale.attempts < stale.max_attempts THEN $2 ELSE target.available_at END,
            last_error = COALESCE(target.last_error, 'Outbox relay exceeded processing visibility timeout')
        FROM stale
        WHERE target.id = stale.id
        RETURNING target.id`,
        [cutoff, nowMs],
      );
      return rows.length;
    },

    async purgePublished(olderThanMs = 0, nowMs = Date.now()): Promise<number> {
      const cutoff = nowMs - Math.max(0, olderThanMs);
      const rows = await defaultRunner.query<{ readonly id: string }>(
        `DELETE FROM ${qualifiedTable}
         WHERE status = 'published'
           AND COALESCE(published_at, created_at) <= $1
         RETURNING id`,
        [cutoff],
      );
      return rows.length;
    },

    async stats(): Promise<OutboxStats> {
      const rows = await defaultRunner.query<{ readonly status: OutboxStatus; readonly cnt: number | string }>(
        `SELECT status, COUNT(*)::int AS cnt FROM ${qualifiedTable} GROUP BY status`,
      );
      let pending = 0;
      let processing = 0;
      let published = 0;
      let dead = 0;
      for (const r of rows) {
        const cnt = Number(r.cnt);
        if (r.status === 'pending') pending = cnt;
        else if (r.status === 'processing') processing = cnt;
        else if (r.status === 'published') published = cnt;
        else if (r.status === 'dead') dead = cnt;
      }
      return { pending, processing, published, dead };
    },
  };
}

export type OutboxPublisher = (record: OutboxRecord) => Promise<void> | void;

export interface TransactionalOutboxOptions {
  /** Underlying outbox storage adapter (or omit and pass `sql` for PostgreSQL or default to in-memory). */
  readonly store?: OutboxStoreAdapter;
  /** Optional PostgreSQL SQL runner to automatically create a `PostgresOutboxStore`. */
  readonly sql?: PostgresQueueSqlLike;
  /** Optional PostgreSQL outbox table configuration when `sql` is provided. */
  readonly postgresOptions?: PostgresOutboxStoreOptions;
  /** Optional target `QueueAdapter` to forward committed outbox records into. */
  readonly queue?: QueueAdapter;
  /** Optional `@forge-fr/core` `EventDispatcher` to emit committed outbox records into. */
  readonly events?: EventDispatcher<Record<string, unknown>>;
  /** Optional custom publisher callback invoked for each claimed outbox record. */
  readonly publisher?: OutboxPublisher;
  /** Optional mapper transforming an outbox `topic` into a queue job name (default: identity `topic`). */
  readonly mapTopicToJobName?: (topic: string) => string;
  /** Default maximum relay attempts before moving an outbox record to `'dead'` (default: `5`). */
  readonly defaultMaxAttempts?: number;
  /** Default retry backoff policy for failed relay attempts. */
  readonly defaultBackoff?: BackoffPolicy;
  /** Maximum payload size in bytes (default: `1048576` = 1 MiB). */
  readonly maxPayloadBytes?: number;
  /** Maximum records claimed per `relayBatch()` call (default: `50`). */
  readonly batchSize?: number;
  /** Background relay polling interval in ms when `startRelay()` is running (default: `100`). */
  readonly pollIntervalMs?: number;
  /** Visibility timeout in ms for reclaiming stale `'processing'` records (default: `300_000` = 5 min). */
  readonly visibilityTimeoutMs?: number;
  /** Optional deterministic clock (default: `Date.now`). */
  readonly now?: () => number;
  /** Optional hook invoked when an outbox record is successfully published. */
  readonly onPublished?: (record: OutboxRecord, job?: QueueJob) => void | Promise<void>;
  /** Optional hook invoked when an outbox relay attempt fails. */
  readonly onFailed?: (record: OutboxRecord, error: unknown) => void | Promise<void>;
  /** Optional hook invoked when an outbox record exhausts `maxAttempts` and enters `'dead'` state. */
  readonly onDeadLetter?: (record: OutboxRecord, error: unknown) => void | Promise<void>;
}

export interface OutboxRelayResult {
  readonly claimed: number;
  readonly published: number;
  readonly retried: number;
  readonly deadLettered: number;
  readonly jobs: readonly QueueJob[];
}

export interface TransactionalOutbox {
  readonly store: OutboxStoreAdapter;
  readonly relaying: boolean;
  ensureSchema(): Promise<void>;
  enqueue<TPayload = unknown>(
    topic: string,
    payload: TPayload,
    options?: OutboxEnqueueOptions,
  ): Promise<OutboxRecord<TPayload>>;
  enqueueBatch(
    entries: readonly OutboxBatchEntry[],
    options?: { readonly tx?: OutboxTransactionHandle },
  ): Promise<readonly OutboxRecord[]>;
  relayBatch(options?: { readonly batchSize?: number; readonly nowMs?: number }): Promise<OutboxRelayResult>;
  reclaimStaleProcessing(maxAgeMs?: number): Promise<number>;
  purgePublished(olderThanMs?: number): Promise<number>;
  getRecord<TPayload = unknown>(id: string): Promise<OutboxRecord<TPayload> | undefined>;
  getDeadLetters(): Promise<readonly OutboxRecord[]>;
  replayDeadLetter(id: string): Promise<OutboxRecord>;
  stats(): Promise<OutboxStats>;
  startRelay(): void;
  stopRelay(): Promise<void>;
}

export function createTransactionalOutbox(
  options: TransactionalOutboxOptions = {},
): TransactionalOutbox {
  const clock = options.now ?? (() => Date.now());
  const store: OutboxStoreAdapter =
    options.store ??
    (options.sql
      ? createPostgresOutboxStore(options.sql, options.postgresOptions)
      : createMemoryOutboxStore({ now: clock }));

  const defaultMaxAttempts = options.defaultMaxAttempts ?? 5;
  const defaultBackoff = options.defaultBackoff ?? DEFAULT_OUTBOX_BACKOFF;
  const maxPayloadBytes = options.maxPayloadBytes ?? 1_048_576;
  const defaultBatchSize = Math.max(1, options.batchSize ?? 50);
  const pollIntervalMs = Math.max(10, options.pollIntervalMs ?? 100);
  const visibilityTimeoutMs = Math.max(100, options.visibilityTimeoutMs ?? 300_000);
  const mapTopicToJobName = options.mapTopicToJobName ?? ((t: string) => t);

  let relaying = false;
  let timer: ReturnType<typeof setInterval> | null = null;
  let activeRelayPromise: Promise<OutboxRelayResult> | null = null;

  async function enqueueSingle<TPayload = unknown>(
    topic: string,
    payload: TPayload,
    enqueueOpts: OutboxEnqueueOptions = {},
  ): Promise<OutboxRecord<TPayload>> {
    const validTopic = validateJobName(topic);
    const sanitized = sanitizePayload(payload);
    assertPayloadSizeLimit(sanitized, maxPayloadBytes);

    const priority = enqueueOpts.priority ?? 100;
    if (!Number.isFinite(priority)) {
      throw new QueueValidationError('priority must be a finite number');
    }

    const maxAttempts = enqueueOpts.maxAttempts ?? defaultMaxAttempts;
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
      throw new QueueValidationError('maxAttempts must be a positive integer');
    }

    const delayMs = enqueueOpts.delayMs ?? 0;
    if (!Number.isFinite(delayMs) || delayMs < 0) {
      throw new QueueValidationError('delayMs must be a non-negative finite number');
    }

    const idempotencyKey =
      enqueueOpts.idempotencyKey !== undefined
        ? validateIdempotencyKey(enqueueOpts.idempotencyKey)
        : undefined;

    const currentTime = clock();
    const id = globalThis.crypto.randomUUID();

    return store.insert<TPayload>(
      {
        id,
        topic: validTopic,
        payload: sanitized,
        priority,
        maxAttempts,
        ...(enqueueOpts.backoff !== undefined ? { backoff: enqueueOpts.backoff } : {}),
        ...(enqueueOpts.timeoutMs !== undefined ? { timeoutMs: enqueueOpts.timeoutMs } : {}),
        ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
        ...(enqueueOpts.headers !== undefined ? { headers: enqueueOpts.headers } : {}),
        createdAt: currentTime,
        availableAt: currentTime + delayMs,
      },
      enqueueOpts.tx,
    );
  }

  async function executeRelayBatch(
    batchOptions: { readonly batchSize?: number; readonly nowMs?: number } = {},
  ): Promise<OutboxRelayResult> {
    const now = batchOptions.nowMs ?? clock();
    const limit = batchOptions.batchSize ?? defaultBatchSize;
    const claimedRecords = await store.claimBatch(limit, now);

    let published = 0;
    let retried = 0;
    let deadLettered = 0;
    const jobs: QueueJob[] = [];

    for (const record of claimedRecords) {
      try {
        let forwardedJob: QueueJob | undefined;

        if (options.queue) {
          const jobName = validateJobName(mapTopicToJobName(record.topic));
          const dedupKey = record.idempotencyKey ?? `outbox:${record.id}`;
          forwardedJob = await options.queue.enqueue(jobName, record.payload, {
            priority: record.priority,
            maxAttempts: record.maxAttempts,
            ...(record.backoff !== undefined ? { backoff: record.backoff } : {}),
            ...(record.timeoutMs !== undefined ? { timeoutMs: record.timeoutMs } : {}),
            idempotencyKey: dedupKey,
          });
          jobs.push(forwardedJob);
        }

        if (options.events) {
          await options.events.emit(record.topic, record.payload);
        }

        if (options.publisher) {
          await options.publisher(record);
        }

        if (!options.queue && !options.events && !options.publisher) {
          throw new QueueValidationError(
            'TransactionalOutbox requires at least one delivery target ("queue", "events", or "publisher")',
          );
        }

        const pubRecord = await store.markPublished(record.id, now);
        published += 1;
        await options.onPublished?.(pubRecord, forwardedJob);
      } catch (err: unknown) {
        const outcome = await store.markFailed(record.id, err, now, defaultBackoff);
        await options.onFailed?.(outcome.record, err);
        if (outcome.status === 'dead') {
          deadLettered += 1;
          await options.onDeadLetter?.(outcome.record, err);
        } else {
          retried += 1;
        }
      }
    }

    return {
      claimed: claimedRecords.length,
      published,
      retried,
      deadLettered,
      jobs,
    };
  }

  return {
    store,

    get relaying(): boolean {
      return relaying;
    },

    async ensureSchema(): Promise<void> {
      await store.ensureSchema();
    },

    enqueue: enqueueSingle,

    async enqueueBatch(
      entries: readonly OutboxBatchEntry[],
      batchOpts?: { readonly tx?: OutboxTransactionHandle },
    ): Promise<readonly OutboxRecord[]> {
      const results: OutboxRecord[] = [];
      for (const item of entries) {
        const rec = await enqueueSingle(item.topic, item.payload, {
          ...(item.options ?? {}),
          ...(batchOpts?.tx !== undefined ? { tx: batchOpts.tx } : {}),
        });
        results.push(rec);
      }
      return results;
    },

    async relayBatch(
      batchOptions?: { readonly batchSize?: number; readonly nowMs?: number },
    ): Promise<OutboxRelayResult> {
      const promise = executeRelayBatch(batchOptions);
      activeRelayPromise = promise;
      try {
        return await promise;
      } finally {
        if (activeRelayPromise === promise) {
          activeRelayPromise = null;
        }
      }
    },

    async reclaimStaleProcessing(maxAgeMs = visibilityTimeoutMs): Promise<number> {
      return store.reclaimStaleProcessing(maxAgeMs, clock());
    },

    async purgePublished(olderThanMs = 0): Promise<number> {
      return store.purgePublished(olderThanMs, clock());
    },

    async getRecord<TPayload = unknown>(id: string): Promise<OutboxRecord<TPayload> | undefined> {
      return store.getRecord<TPayload>(id);
    },

    async getDeadLetters(): Promise<readonly OutboxRecord[]> {
      return store.getDeadLetters();
    },

    async replayDeadLetter(id: string): Promise<OutboxRecord> {
      return store.replayDeadLetter(id, clock());
    },

    async stats(): Promise<OutboxStats> {
      return store.stats();
    },

    startRelay(): void {
      if (relaying) return;
      relaying = true;
      timer = setInterval(() => {
        if (!relaying || activeRelayPromise !== null) return;
        void this.relayBatch().catch(() => {});
      }, pollIntervalMs);
      if (typeof timer === 'object' && timer !== null && 'unref' in timer) {
        (timer as { unref?: () => void }).unref?.();
      }
    },

    async stopRelay(): Promise<void> {
      relaying = false;
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
      if (activeRelayPromise !== null) {
        try {
          await activeRelayPromise;
        } catch {
          // Ignore errors on stop
        }
      }
    },
  };
}
