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
  PersistentQueueAdapter,
  QueueJob,
  QueueStats,
  RedisQueueClientLike,
  RedisQueueOptions,
} from './types.js';

interface StoredRedisJob {
  id: string;
  name: string;
  payload: unknown;
  status: JobStatus;
  priority: number;
  attempts: number;
  maxAttempts: number;
  backoff?: BackoffPolicy;
  timeoutMs?: number;
  idempotencyKey?: string;
  createdAt: number;
  availableAt: number;
  startedAt?: number;
  completedAt?: number;
  result?: unknown;
  lastError?: string;
  seq: number;
}

const DEFAULT_BACKOFF: BackoffPolicy = {
  type: 'exponential',
  delayMs: 50,
  maxDelayMs: 10_000,
  jitter: false,
};

const ALL_STATUSES: readonly JobStatus[] = ['waiting', 'delayed', 'active', 'completed', 'dead'];

function toPublicJob<TPayload = unknown, TResult = unknown>(
  rec: StoredRedisJob,
): QueueJob<TPayload, TResult> {
  return {
    id: rec.id,
    name: rec.name,
    payload: sanitizePayload(rec.payload) as TPayload,
    status: rec.status,
    priority: rec.priority,
    attempts: rec.attempts,
    maxAttempts: rec.maxAttempts,
    ...(rec.backoff !== undefined ? { backoff: rec.backoff } : {}),
    ...(rec.timeoutMs !== undefined ? { timeoutMs: rec.timeoutMs } : {}),
    ...(rec.idempotencyKey !== undefined ? { idempotencyKey: rec.idempotencyKey } : {}),
    createdAt: rec.createdAt,
    availableAt: rec.availableAt,
    ...(rec.startedAt !== undefined ? { startedAt: rec.startedAt } : {}),
    ...(rec.completedAt !== undefined ? { completedAt: rec.completedAt } : {}),
    ...(rec.result !== undefined ? { result: rec.result as TResult } : {}),
    ...(rec.lastError !== undefined ? { lastError: rec.lastError } : {}),
  };
}

function validatePrefix(prefix: string): string {
  if (!/^[A-Za-z0-9:._-]{1,128}$/.test(prefix)) {
    throw new QueueValidationError('Invalid Redis queue keyPrefix');
  }
  return prefix;
}

function computePriorityScore(priority: number, seq: number): number {
  return priority * 1_000_000 + (seq % 1_000_000);
}

export function createRedisQueueAdapter(
  client: RedisQueueClientLike,
  options: RedisQueueOptions = {},
): PersistentQueueAdapter {
  const keyPrefix = validatePrefix(options.keyPrefix ?? 'forge:queue');
  const maxQueueSize = options.maxQueueSize ?? 100_000;
  const maxPayloadBytes = options.maxPayloadBytes ?? 1_048_576;
  const defaultMaxAttempts = options.defaultMaxAttempts ?? 3;
  const defaultBackoff = options.defaultBackoff ?? DEFAULT_BACKOFF;
  const visibilityTimeoutMs = options.visibilityTimeoutMs ?? 300_000;
  const statsCacheTtlMs = options.statsCacheTtlMs ?? 1_000;
  const now = options.now ?? (() => Date.now());

  if (!Number.isInteger(maxQueueSize) || maxQueueSize < 1) {
    throw new QueueValidationError('maxQueueSize must be a positive integer');
  }
  if (!Number.isFinite(visibilityTimeoutMs) || visibilityTimeoutMs < 1) {
    throw new QueueValidationError('visibilityTimeoutMs must be a positive number');
  }

  let seq = 0;
  let lastStats: QueueStats = {
    waiting: 0,
    delayed: 0,
    active: 0,
    completed: 0,
    dead: 0,
  };
  let lastStatsFetchedAt = -1;

  const zsetKey = (status: JobStatus): string => `${keyPrefix}:z:${status}`;
  const jobKey = (jobId: string): string => `${keyPrefix}:job:${jobId}`;
  const idempKey = (key: string): string => `${keyPrefix}:idemp:${key}`;

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

  async function readJob(jobId: string): Promise<StoredRedisJob | undefined> {
    const raw = await client.get(jobKey(jobId));
    if (raw === null) {
      return undefined;
    }
    try {
      return JSON.parse(raw) as StoredRedisJob;
    } catch {
      return undefined;
    }
  }

  async function writeJob(record: StoredRedisJob): Promise<void> {
    await client.set(jobKey(record.id), JSON.stringify(record));
  }

  async function releaseIdempotency(record: StoredRedisJob): Promise<void> {
    if (record.idempotencyKey === undefined) {
      return;
    }
    const existing = await client.get(idempKey(record.idempotencyKey));
    if (existing === record.id) {
      await client.del(idempKey(record.idempotencyKey));
    }
  }

  async function refreshStats(): Promise<QueueStats> {
    const [waiting, delayed, active, completed, dead] = await Promise.all([
      client.zcard(zsetKey('waiting')),
      client.zcard(zsetKey('delayed')),
      client.zcard(zsetKey('active')),
      client.zcard(zsetKey('completed')),
      client.zcard(zsetKey('dead')),
    ]);
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

  async function promoteDelayed(currentTime: number): Promise<void> {
    const dueIds = await client.zrangebyscore(zsetKey('delayed'), '-inf', currentTime, 'LIMIT', 0, 50);
    for (const jobId of dueIds) {
      const removed = await client.zrem(zsetKey('delayed'), jobId);
      if (removed === 0) {
        continue;
      }
      const job = await readJob(jobId);
      if (!job) continue;
      job.status = 'waiting';
      await writeJob(job);
      await client.zadd(zsetKey('waiting'), computePriorityScore(job.priority, job.seq), job.id);
      adjustLocalStat('delayed', 'waiting');
    }
  }

  async function atomicPopWaitingId(): Promise<string | undefined> {
    if (typeof client.eval === 'function') {
      const luaScript = `
        local items = redis.call('ZRANGE', KEYS[1], 0, 0)
        if #items == 0 then return nil end
        redis.call('ZREM', KEYS[1], items[1])
        return items[1]
      `;
      const popped = await client.eval(luaScript, 1, zsetKey('waiting'));
      return typeof popped === 'string' && popped.length > 0 ? popped : undefined;
    }

    const candidates = await client.zrangebyscore(zsetKey('waiting'), '-inf', '+inf', 'LIMIT', 0, 5);
    for (const jobId of candidates) {
      const claimed = await client.zrem(zsetKey('waiting'), jobId);
      if (claimed > 0) {
        return jobId;
      }
    }
    return undefined;
  }

  return {
    driver: 'redis',

    async connect(): Promise<void> {
      const pong = await client.ping();
      if (pong.toUpperCase() !== 'PONG' && pong.toUpperCase() !== 'OK') {
        throw new QueueError(`Unexpected Redis ping response: "${pong}"`);
      }
      await refreshStats();
    },

    async disconnect(): Promise<void> {
      if (typeof client.quit === 'function') {
        await client.quit();
      }
    },

    async ping(): Promise<boolean> {
      try {
        const res = await client.ping();
        return res.length > 0;
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
        const existingId = await client.get(idempKey(idempotencyKey));
        if (existingId !== null) {
          const existing = await readJob(existingId);
          if (
            existing !== undefined &&
            (existing.status === 'waiting' ||
              existing.status === 'delayed' ||
              existing.status === 'active')
          ) {
            return toPublicJob<TPayload>(existing);
          }
          await client.del(idempKey(idempotencyKey));
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
      seq = (seq + 1) % 1_000_000;
      const initialStatus: JobStatus = delayMs > 0 ? 'delayed' : 'waiting';
      const record: StoredRedisJob = {
        id: globalThis.crypto.randomUUID(),
        name: validName,
        payload: sanitized,
        status: initialStatus,
        priority,
        attempts: 0,
        maxAttempts,
        backoff: enqueueOptions.backoff ?? defaultBackoff,
        ...(enqueueOptions.timeoutMs !== undefined ? { timeoutMs: enqueueOptions.timeoutMs } : {}),
        ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
        createdAt: currentTime,
        availableAt: currentTime + delayMs,
        seq,
      };

      await writeJob(record);
      if (idempotencyKey !== undefined) {
        await client.set(idempKey(idempotencyKey), record.id);
      }

      const score =
        initialStatus === 'delayed'
          ? record.availableAt
          : computePriorityScore(record.priority, record.seq);
      await client.zadd(zsetKey(initialStatus), score, record.id);
      adjustLocalStat(null, initialStatus);

      return toPublicJob<TPayload>(record);
    },

    async dequeue(): Promise<QueueJob | undefined> {
      const currentTime = now();
      await promoteDelayed(currentTime);

      for (let attempt = 0; attempt < 5; attempt += 1) {
        const jobId = await atomicPopWaitingId();
        if (!jobId) {
          return undefined;
        }
        const record = await readJob(jobId);
        if (!record) {
          continue;
        }
        record.status = 'active';
        record.attempts += 1;
        record.startedAt = currentTime;
        await writeJob(record);
        await client.zadd(zsetKey('active'), currentTime, record.id);
        adjustLocalStat('waiting', 'active');
        return toPublicJob(record);
      }

      return undefined;
    },

    async complete<TResult = unknown>(jobId: string, result?: TResult): Promise<QueueJob> {
      const record = await readJob(jobId);
      if (!record) {
        throw new QueueError(`Unknown job "${jobId}"`, { statusCode: 404, expose: true });
      }

      const prevStatus = record.status;
      const currentTime = now();
      await client.zrem(zsetKey(prevStatus), record.id);
      record.status = 'completed';
      record.completedAt = currentTime;
      if (result !== undefined) {
        record.result = sanitizePayload(result);
      }
      await writeJob(record);
      await client.zadd(zsetKey('completed'), currentTime, record.id);
      await releaseIdempotency(record);
      adjustLocalStat(prevStatus, 'completed');
      return toPublicJob(record);
    },

    async fail(jobId: string, error: unknown): Promise<FailJobOutcome> {
      const record = await readJob(jobId);
      if (!record) {
        throw new QueueError(`Unknown job "${jobId}"`, { statusCode: 404, expose: true });
      }

      const prevStatus = record.status;
      const currentTime = now();
      await client.zrem(zsetKey(prevStatus), record.id);
      record.lastError = error instanceof Error ? error.message : String(error);

      if (record.attempts < record.maxAttempts) {
        const policy = record.backoff ?? defaultBackoff;
        const retryDelay = computeBackoffDelayMs(policy, record.attempts);
        record.status = 'delayed';
        record.availableAt = currentTime + retryDelay;
        await writeJob(record);
        await client.zadd(zsetKey('delayed'), record.availableAt, record.id);
        adjustLocalStat(prevStatus, 'delayed');
        return { status: 'delayed', job: toPublicJob(record) };
      }

      record.status = 'dead';
      record.completedAt = currentTime;
      await writeJob(record);
      await client.zadd(zsetKey('dead'), currentTime, record.id);
      await releaseIdempotency(record);
      adjustLocalStat(prevStatus, 'dead');
      return { status: 'dead', job: toPublicJob(record) };
    },

    async getJob<TPayload = unknown, TResult = unknown>(
      jobId: string,
    ): Promise<QueueJob<TPayload, TResult> | undefined> {
      const record = await readJob(jobId);
      return record ? toPublicJob<TPayload, TResult>(record) : undefined;
    },

    async getDeadLetters(): Promise<readonly QueueJob[]> {
      const deadIds = await client.zrangebyscore(zsetKey('dead'), '-inf', '+inf');
      const items: QueueJob[] = [];
      for (const id of deadIds) {
        const record = await readJob(id);
        if (record && record.status === 'dead') {
          items.push(toPublicJob(record));
        }
      }
      return items;
    },

    async replayDeadLetter(jobId: string): Promise<QueueJob> {
      const record = await readJob(jobId);
      if (!record) {
        throw new QueueError(`Dead-letter job "${jobId}" not found`, {
          statusCode: 404,
          expose: true,
        });
      }
      if (record.status !== 'dead') {
        throw new QueueValidationError(`Job "${jobId}" is in "${record.status}" state, not "dead"`);
      }

      await client.zrem(zsetKey('dead'), record.id);
      const currentTime = now();
      record.status = 'waiting';
      record.attempts = 0;
      record.availableAt = currentTime;
      delete record.startedAt;
      delete record.completedAt;
      await writeJob(record);
      if (record.idempotencyKey !== undefined) {
        await client.set(idempKey(record.idempotencyKey), record.id);
      }
      await client.zadd(zsetKey('waiting'), computePriorityScore(record.priority, record.seq), record.id);
      adjustLocalStat('dead', 'waiting');
      return toPublicJob(record);
    },

    async reclaimStaleJobs(maxAgeMs = visibilityTimeoutMs): Promise<number> {
      if (!Number.isFinite(maxAgeMs) || maxAgeMs < 1) {
        throw new QueueValidationError('visibilityTimeoutMs must be a positive number');
      }
      const currentTime = now();
      const cutoff = currentTime - maxAgeMs;
      const staleIds = await client.zrangebyscore(zsetKey('active'), '-inf', cutoff);
      let reclaimed = 0;

      for (const id of staleIds) {
        const removed = await client.zrem(zsetKey('active'), id);
        if (removed === 0) {
          continue;
        }
        const record = await readJob(id);
        if (!record || record.status !== 'active') {
          continue;
        }
        record.lastError = record.lastError ?? 'Job exceeded visibility timeout';
        if (record.attempts < record.maxAttempts) {
          record.status = 'waiting';
          record.availableAt = currentTime;
          delete record.startedAt;
          await writeJob(record);
          await client.zadd(
            zsetKey('waiting'),
            computePriorityScore(record.priority, record.seq),
            record.id,
          );
          adjustLocalStat('active', 'waiting');
        } else {
          record.status = 'dead';
          record.completedAt = currentTime;
          await writeJob(record);
          await client.zadd(zsetKey('dead'), currentTime, record.id);
          await releaseIdempotency(record);
          adjustLocalStat('active', 'dead');
        }
        reclaimed += 1;
      }

      return reclaimed;
    },

    async purge(status?: JobStatus): Promise<number> {
      const targets = status !== undefined ? [status] : ALL_STATUSES;
      let removed = 0;
      for (const target of targets) {
        const ids = await client.zrangebyscore(zsetKey(target), '-inf', '+inf');
        if (ids.length === 0) continue;
        await client.zrem(zsetKey(target), ...ids);
        for (const id of ids) {
          const rec = await readJob(id);
          if (rec) {
            await releaseIdempotency(rec);
          }
          await client.del(jobKey(id));
          removed += 1;
        }
      }
      await refreshStats();
      return removed;
    },

    stats(): QueueStats {
      return lastStats;
    },

    async fetchStats(): Promise<QueueStats> {
      return refreshStats();
    },
  };
}
