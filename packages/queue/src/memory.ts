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
  MemoryQueueOptions,
  QueueAdapter,
  QueueJob,
  QueueStats,
} from './types.js';

interface InternalJobRecord {
  readonly id: string;
  readonly name: string;
  readonly payload: unknown;
  status: JobStatus;
  readonly priority: number;
  attempts: number;
  readonly maxAttempts: number;
  readonly backoff?: BackoffPolicy;
  readonly timeoutMs?: number;
  readonly idempotencyKey?: string;
  readonly createdAt: number;
  availableAt: number;
  startedAt?: number;
  completedAt?: number;
  result?: unknown;
  lastError?: string;
  readonly seq: number;
}

const DEFAULT_BACKOFF: BackoffPolicy = {
  type: 'exponential',
  delayMs: 50,
  maxDelayMs: 10_000,
  jitter: false,
};

function toPublicJob<TPayload = unknown, TResult = unknown>(
  rec: InternalJobRecord,
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

export function createMemoryQueueAdapter(options: MemoryQueueOptions = {}): QueueAdapter {
  const maxQueueSize = options.maxQueueSize ?? 10_000;
  const maxPayloadBytes = options.maxPayloadBytes ?? 1_048_576;
  const defaultMaxAttempts = options.defaultMaxAttempts ?? 3;
  const defaultBackoff = options.defaultBackoff ?? DEFAULT_BACKOFF;
  const now = options.now ?? (() => Date.now());

  if (!Number.isInteger(maxQueueSize) || maxQueueSize < 1) {
    throw new QueueValidationError('maxQueueSize must be a positive integer');
  }

  const jobs = new Map<string, InternalJobRecord>();
  const idempotencyIndex = new Map<string, string>();
  let sequenceCounter = 0;
  let connected = false;

  function activeQueueDepth(): number {
    let count = 0;
    for (const job of jobs.values()) {
      if (job.status === 'waiting' || job.status === 'delayed' || job.status === 'active') {
        count += 1;
      }
    }
    return count;
  }

  function releaseIdempotency(job: InternalJobRecord): void {
    if (job.idempotencyKey !== undefined && idempotencyIndex.get(job.idempotencyKey) === job.id) {
      idempotencyIndex.delete(job.idempotencyKey);
    }
  }

  return {
    driver: 'memory',

    async connect(): Promise<void> {
      connected = true;
    },

    async disconnect(): Promise<void> {
      connected = false;
    },

    async ping(): Promise<boolean> {
      return connected;
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
        const existingId = idempotencyIndex.get(idempotencyKey);
        if (existingId !== undefined) {
          const existing = jobs.get(existingId);
          if (
            existing !== undefined &&
            (existing.status === 'waiting' ||
              existing.status === 'delayed' ||
              existing.status === 'active')
          ) {
            return toPublicJob<TPayload>(existing);
          }
          idempotencyIndex.delete(idempotencyKey);
        }
      }

      if (activeQueueDepth() >= maxQueueSize) {
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
      sequenceCounter += 1;
      const record: InternalJobRecord = {
        id: globalThis.crypto.randomUUID(),
        name: validName,
        payload: sanitized,
        status: delayMs > 0 ? 'delayed' : 'waiting',
        priority,
        attempts: 0,
        maxAttempts,
        backoff: enqueueOptions.backoff ?? defaultBackoff,
        ...(enqueueOptions.timeoutMs !== undefined ? { timeoutMs: enqueueOptions.timeoutMs } : {}),
        ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
        createdAt: currentTime,
        availableAt: currentTime + delayMs,
        seq: sequenceCounter,
      };

      jobs.set(record.id, record);
      if (idempotencyKey !== undefined) {
        idempotencyIndex.set(idempotencyKey, record.id);
      }

      return toPublicJob<TPayload>(record);
    },

    async dequeue(): Promise<QueueJob | undefined> {
      const currentTime = now();
      let candidate: InternalJobRecord | undefined;

      for (const job of jobs.values()) {
        if (job.status === 'delayed' && job.availableAt <= currentTime) {
          job.status = 'waiting';
        }
        if (job.status === 'waiting' && job.availableAt <= currentTime) {
          if (
            candidate === undefined ||
            job.priority < candidate.priority ||
            (job.priority === candidate.priority && job.seq < candidate.seq)
          ) {
            candidate = job;
          }
        }
      }

      if (candidate === undefined) {
        return undefined;
      }

      candidate.status = 'active';
      candidate.attempts += 1;
      candidate.startedAt = currentTime;
      return toPublicJob(candidate);
    },

    async complete<TResult = unknown>(jobId: string, result?: TResult): Promise<QueueJob> {
      const record = jobs.get(jobId);
      if (!record) {
        throw new QueueError(`Unknown job "${jobId}"`, { statusCode: 404, expose: true });
      }
      record.status = 'completed';
      record.completedAt = now();
      if (result !== undefined) {
        record.result = sanitizePayload(result);
      }
      releaseIdempotency(record);
      return toPublicJob(record);
    },

    async fail(jobId: string, error: unknown): Promise<FailJobOutcome> {
      const record = jobs.get(jobId);
      if (!record) {
        throw new QueueError(`Unknown job "${jobId}"`, { statusCode: 404, expose: true });
      }

      const errorMessage = error instanceof Error ? error.message : String(error);
      record.lastError = errorMessage;

      if (record.attempts < record.maxAttempts) {
        const policy = record.backoff ?? defaultBackoff;
        const retryDelay = computeBackoffDelayMs(policy, record.attempts);
        record.status = 'delayed';
        record.availableAt = now() + retryDelay;
        return {
          status: 'delayed',
          job: toPublicJob(record),
        };
      }

      record.status = 'dead';
      record.completedAt = now();
      releaseIdempotency(record);
      return {
        status: 'dead',
        job: toPublicJob(record),
      };
    },

    async getJob<TPayload = unknown, TResult = unknown>(
      jobId: string,
    ): Promise<QueueJob<TPayload, TResult> | undefined> {
      const record = jobs.get(jobId);
      return record ? toPublicJob<TPayload, TResult>(record) : undefined;
    },

    async getDeadLetters(): Promise<readonly QueueJob[]> {
      const dead: QueueJob[] = [];
      for (const job of jobs.values()) {
        if (job.status === 'dead') {
          dead.push(toPublicJob(job));
        }
      }
      return dead;
    },

    async replayDeadLetter(jobId: string): Promise<QueueJob> {
      const record = jobs.get(jobId);
      if (!record) {
        throw new QueueError(`Dead-letter job "${jobId}" not found`, {
          statusCode: 404,
          expose: true,
        });
      }
      if (record.status !== 'dead') {
        throw new QueueValidationError(`Job "${jobId}" is in "${record.status}" state, not "dead"`);
      }

      record.status = 'waiting';
      record.attempts = 0;
      record.availableAt = now();
      delete record.startedAt;
      delete record.completedAt;
      if (record.idempotencyKey !== undefined) {
        idempotencyIndex.set(record.idempotencyKey, record.id);
      }

      return toPublicJob(record);
    },

    async purge(status?: JobStatus): Promise<number> {
      let removed = 0;
      for (const [id, job] of jobs) {
        if (status === undefined || job.status === status) {
          releaseIdempotency(job);
          jobs.delete(id);
          removed += 1;
        }
      }
      return removed;
    },

    stats(): QueueStats {
      let waiting = 0;
      let delayed = 0;
      let active = 0;
      let completed = 0;
      let dead = 0;
      for (const job of jobs.values()) {
        switch (job.status) {
          case 'waiting':
            waiting += 1;
            break;
          case 'delayed':
            delayed += 1;
            break;
          case 'active':
            active += 1;
            break;
          case 'completed':
            completed += 1;
            break;
          case 'dead':
            dead += 1;
            break;
        }
      }
      return { waiting, delayed, active, completed, dead };
    },
  };
}
