export type JobStatus = 'waiting' | 'delayed' | 'active' | 'completed' | 'dead';

export interface BackoffPolicy {
  readonly type: 'fixed' | 'exponential';
  readonly delayMs: number;
  readonly maxDelayMs?: number;
  readonly jitter?: boolean;
}

export interface EnqueueOptions {
  /** Lower values run first. Default: `100`. */
  readonly priority?: number;
  /** Delay before initial execution in milliseconds. */
  readonly delayMs?: number;
  /** Maximum attempts before moving to Dead-Letter Queue. Default: adapter default (`3`). */
  readonly maxAttempts?: number;
  /** Backoff strategy between failed attempts. */
  readonly backoff?: BackoffPolicy;
  /** Per-attempt execution timeout in milliseconds. */
  readonly timeoutMs?: number;
  /** Optional deduplication key across waiting, delayed, and active jobs. */
  readonly idempotencyKey?: string;
}

export interface QueueJob<TPayload = unknown, TResult = unknown> {
  readonly id: string;
  readonly name: string;
  readonly payload: TPayload;
  readonly status: JobStatus;
  readonly priority: number;
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly backoff?: BackoffPolicy;
  readonly timeoutMs?: number;
  readonly idempotencyKey?: string;
  readonly createdAt: number;
  readonly availableAt: number;
  readonly startedAt?: number;
  readonly completedAt?: number;
  readonly result?: TResult;
  readonly lastError?: string;
}

export interface QueueStats {
  readonly waiting: number;
  readonly delayed: number;
  readonly active: number;
  readonly completed: number;
  readonly dead: number;
}

export interface FailJobOutcome {
  readonly status: 'delayed' | 'dead';
  readonly job: QueueJob;
}

export interface QueueAdapter {
  readonly driver: 'memory' | 'redis' | 'postgres' | 'custom';
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  ping(): Promise<boolean>;
  enqueue<TPayload = unknown>(
    name: string,
    payload: TPayload,
    options?: EnqueueOptions,
  ): Promise<QueueJob<TPayload>>;
  dequeue(): Promise<QueueJob | undefined>;
  complete<TResult = unknown>(jobId: string, result?: TResult): Promise<QueueJob>;
  fail(jobId: string, error: unknown): Promise<FailJobOutcome>;
  getJob<TPayload = unknown, TResult = unknown>(
    jobId: string,
  ): Promise<QueueJob<TPayload, TResult> | undefined>;
  getDeadLetters(): Promise<readonly QueueJob[]>;
  replayDeadLetter(jobId: string): Promise<QueueJob>;
  purge(status?: JobStatus): Promise<number>;
  stats(): QueueStats;
  fetchStats?(): Promise<QueueStats>;
}

export interface PersistentQueueAdapter extends QueueAdapter {
  fetchStats(): Promise<QueueStats>;
  reclaimStaleJobs(visibilityTimeoutMs?: number): Promise<number>;
}

export interface MemoryQueueOptions {
  /** Maximum non-terminal (waiting + delayed + active) jobs held simultaneously. Default: `10000`. */
  readonly maxQueueSize?: number;
  /** Maximum serialized UTF-8 byte size for a job payload. Default: `1048576` (1 MiB). */
  readonly maxPayloadBytes?: number;
  /** Default attempts limit. Default: `3`. */
  readonly defaultMaxAttempts?: number;
  /** Default per-job backoff policy. */
  readonly defaultBackoff?: BackoffPolicy;
  /** Optional deterministic clock for testing. Default: `Date.now`. */
  readonly now?: () => number;
}

export interface RedisQueueClientLike {
  ping(): Promise<string>;
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ...args: unknown[]): Promise<unknown>;
  del(...keys: string[]): Promise<number>;
  zadd(key: string, score: number, member: string): Promise<number>;
  zrem(key: string, ...members: string[]): Promise<number>;
  zrangebyscore(
    key: string,
    min: number | string,
    max: number | string,
    ...args: unknown[]
  ): Promise<string[]>;
  zcard(key: string): Promise<number>;
  eval?(script: string, numkeys: number, ...args: (string | number)[]): Promise<unknown>;
  quit?(): Promise<unknown>;
}

export interface RedisQueueOptions {
  /** Key prefix namespace. Default: `'forge:queue'`. */
  readonly keyPrefix?: string;
  /** Maximum non-terminal jobs allowed across waiting+delayed+active. Default: `100000`. */
  readonly maxQueueSize?: number;
  /** Maximum serialized payload UTF-8 size in bytes. Default: `1048576` (1 MiB). */
  readonly maxPayloadBytes?: number;
  /** Default attempts limit. Default: `3`. */
  readonly defaultMaxAttempts?: number;
  /** Default backoff policy. */
  readonly defaultBackoff?: BackoffPolicy;
  /** Default active job visibility timeout (ms) used by `reclaimStaleJobs()`. Default: `300000` (5 min). */
  readonly visibilityTimeoutMs?: number;
  /** Optional cache TTL (ms) before re-querying Redis `ZCARD` stats on capacity checks. Default: `1000`. */
  readonly statsCacheTtlMs?: number;
  /** Optional deterministic clock for testing. Default: `Date.now`. */
  readonly now?: () => number;
}

export interface PostgresQueryResult<TRow = Record<string, unknown>> {
  readonly rows: readonly TRow[];
}

export type PostgresQueueSqlLike =
  | {
      query<TRow = Record<string, unknown>>(
        text: string,
        params?: readonly unknown[],
      ): Promise<PostgresQueryResult<TRow>>;
      ping?(): Promise<boolean>;
      end?(): Promise<void>;
    }
  | {
      unsafe<TRow = Record<string, unknown>>(
        text: string,
        params?: readonly unknown[],
      ): Promise<readonly TRow[]>;
      end?(): Promise<void>;
    };

export interface PostgresQueueOptions {
  /** SQL table name (strictly validated against `[a-zA-Z_][a-zA-Z0-9_]*`). Default: `'forge_jobs'`. */
  readonly tableName?: string;
  /** Optional PostgreSQL schema name. Default: `'public'`. */
  readonly schemaName?: string;
  /** Maximum non-terminal jobs allowed across waiting+delayed+active. Default: `100000`. */
  readonly maxQueueSize?: number;
  /** Maximum serialized payload UTF-8 size in bytes. Default: `1048576` (1 MiB). */
  readonly maxPayloadBytes?: number;
  /** Default attempts limit. Default: `3`. */
  readonly defaultMaxAttempts?: number;
  /** Default backoff policy. */
  readonly defaultBackoff?: BackoffPolicy;
  /** Automatically execute DDL `ensureSchema()` on `connect()`. Default: `true`. */
  readonly autoCreateSchema?: boolean;
  /** Default active job visibility timeout (ms) used by `reclaimStaleJobs()`. Default: `300000` (5 min). */
  readonly visibilityTimeoutMs?: number;
  /** Optional cache TTL (ms) before re-querying PostgreSQL `COUNT(*)` stats on capacity checks. Default: `1000`. */
  readonly statsCacheTtlMs?: number;
  /** Optional deterministic clock for testing. Default: `Date.now`. */
  readonly now?: () => number;
}

export interface PostgresQueueAdapter extends PersistentQueueAdapter {
  readonly driver: 'postgres';
  ensureSchema(): Promise<void>;
}

export interface JobExecutionContext {
  readonly signal: AbortSignal;
  readonly attempt: number;
}

export type JobHandler<TPayload = unknown, TResult = unknown> = (
  job: QueueJob<TPayload, TResult>,
  ctx: JobExecutionContext,
) => Promise<TResult> | TResult;

export interface QueueWorkerOptions {
  /** Polling interval when queue is empty (ms). Default: `25`. */
  readonly pollIntervalMs?: number;
  /** Maximum concurrent jobs processed by this worker. Default: `4`. */
  readonly concurrency?: number;
  /** Fallback per-job timeout if job did not specify `timeoutMs`. */
  readonly defaultTimeoutMs?: number;
  readonly onCompleted?: (job: QueueJob) => void | Promise<void>;
  readonly onFailed?: (job: QueueJob, error: unknown) => void | Promise<void>;
  readonly onDeadLetter?: (job: QueueJob, error: unknown) => void | Promise<void>;
}

export interface QueueWorkerStopOptions {
  /** Maximum grace window in ms to wait for in-flight jobs before aborting. Default: `5000`. */
  readonly timeoutMs?: number;
}

export interface QueueWorker {
  readonly running: boolean;
  readonly activeCount: number;
  start(): void;
  stop(options?: QueueWorkerStopOptions): Promise<void>;
}
