import { describe, expect, it } from 'vitest';
import {
  QueueValidationError,
  createPostgresQueueAdapter,
  createQueueWorker,
  createRedisQueueAdapter,
  type PostgresQueueSqlLike,
  type RedisQueueClientLike,
} from '../src/index.js';

function createInMemoryRedisHarness(): RedisQueueClientLike {
  const strings = new Map<string, string>();
  const zsets = new Map<string, Map<string, number>>();

  const getZ = (key: string): Map<string, number> => {
    let z = zsets.get(key);
    if (!z) {
      z = new Map<string, number>();
      zsets.set(key, z);
    }
    return z;
  };

  return {
    async ping() {
      return 'PONG';
    },
    async get(key) {
      return strings.get(key) ?? null;
    },
    async set(key, value) {
      strings.set(key, value);
      return 'OK';
    },
    async del(...keys) {
      let count = 0;
      for (const k of keys) {
        if (strings.delete(k)) count += 1;
      }
      return count;
    },
    async zadd(key, score, member) {
      const z = getZ(key);
      const existed = z.has(member);
      z.set(member, score);
      return existed ? 0 : 1;
    },
    async zrem(key, ...members) {
      const z = getZ(key);
      let removed = 0;
      for (const m of members) {
        if (z.delete(m)) removed += 1;
      }
      return removed;
    },
    async zrangebyscore(key, min, max, ...args) {
      const z = getZ(key);
      const minVal = min === '-inf' ? -Infinity : Number(min);
      const maxVal = max === '+inf' ? Infinity : Number(max);
      const matched = Array.from(z.entries())
        .filter(([, score]) => score >= minVal && score <= maxVal)
        .sort((a, b) => a[1] - b[1])
        .map(([member]) => member);

      if (args[0] === 'LIMIT' && typeof args[1] === 'number' && typeof args[2] === 'number') {
        return matched.slice(args[1], args[1] + args[2]);
      }
      return matched;
    },
    async zcard(key) {
      return getZ(key).size;
    },
    async eval(script, _numkeys, ...args) {
      if (script.includes("redis.call('ZRANGE'") && typeof args[0] === 'string') {
        const z = getZ(args[0]);
        const sorted = Array.from(z.entries()).sort((a, b) => a[1] - b[1]);
        const picked = sorted[0]?.[0];
        if (!picked) return null;
        z.delete(picked);
        return picked;
      }
      return null;
    },
    async quit() {
      return 'OK';
    },
  };
}

interface StoredRow {
  seq: number;
  id: string;
  name: string;
  payload_json: string;
  status: string;
  priority: number;
  attempts: number;
  max_attempts: number;
  backoff_json: string | null;
  timeout_ms: number | null;
  idempotency_key: string | null;
  created_at: number;
  available_at: number;
  started_at: number | null;
  completed_at: number | null;
  result_json: string | null;
  last_error: string | null;
}

function createFakePostgresSqlHarness(): PostgresQueueSqlLike & {
  readonly statements: string[];
} {
  const rows: StoredRow[] = [];
  const statements: string[] = [];
  let seq = 0;

  return {
    statements,
    async query<TRow = Record<string, unknown>>(text: string, params: readonly unknown[] = []) {
      statements.push(text);

      if (text.startsWith('CREATE TABLE') || text.startsWith('CREATE INDEX') || text.startsWith('CREATE UNIQUE INDEX') || text === 'SELECT 1') {
        return { rows: [] as TRow[] };
      }

      if (text.includes('GROUP BY status')) {
        const counts = new Map<string, number>();
        for (const r of rows) {
          counts.set(r.status, (counts.get(r.status) ?? 0) + 1);
        }
        return {
          rows: Array.from(counts.entries()).map(([status, cnt]) => ({ status, cnt })) as unknown as TRow[],
        };
      }

      if (text.includes('WHERE idempotency_key = $1')) {
        const key = params[0] as string;
        const found = rows.find(
          (r) => r.idempotency_key === key && (r.status === 'waiting' || r.status === 'delayed' || r.status === 'active'),
        );
        return { rows: (found ? [found] : []) as unknown as TRow[] };
      }

      if (text.startsWith('INSERT INTO')) {
        seq += 1;
        const row: StoredRow = {
          seq,
          id: params[0] as string,
          name: params[1] as string,
          payload_json: params[2] as string,
          status: params[3] as string,
          priority: params[4] as number,
          attempts: 0,
          max_attempts: params[5] as number,
          backoff_json: params[6] as string | null,
          timeout_ms: params[7] as number | null,
          idempotency_key: params[8] as string | null,
          created_at: params[9] as number,
          available_at: params[10] as number,
          started_at: null,
          completed_at: null,
          result_json: null,
          last_error: null,
        };
        rows.push(row);
        return { rows: [row] as unknown as TRow[] };
      }

      if (text.includes('WITH next_job AS')) {
        const nowTs = params[0] as number;
        const eligible = rows
          .filter(
            (r) =>
              (r.status === 'waiting' || (r.status === 'delayed' && r.available_at <= nowTs)) &&
              r.available_at <= nowTs,
          )
          .sort((a, b) => (a.priority !== b.priority ? a.priority - b.priority : a.seq - b.seq));
        const picked = eligible[0];
        if (!picked) {
          return { rows: [] as TRow[] };
        }
        picked.status = 'active';
        picked.attempts += 1;
        picked.started_at = nowTs;
        return { rows: [{ ...picked }] as unknown as TRow[] };
      }

      if (text.includes("SET status = 'completed'")) {
        const [id, completedAt, resultJson] = params as [string, number, string | null];
        const row = rows.find((r) => r.id === id);
        if (!row) return { rows: [] as TRow[] };
        row.status = 'completed';
        row.completed_at = completedAt;
        row.result_json = resultJson;
        return { rows: [{ ...row }] as unknown as TRow[] };
      }

      if (text.includes("SET status = 'delayed'")) {
        const [id, availableAt, lastError] = params as [string, number, string];
        const row = rows.find((r) => r.id === id);
        if (!row) return { rows: [] as TRow[] };
        row.status = 'delayed';
        row.available_at = availableAt;
        row.last_error = lastError;
        return { rows: [{ ...row }] as unknown as TRow[] };
      }

      if (text.includes("SET status = 'dead'")) {
        const [id, completedAt, lastError] = params as [string, number, string];
        const row = rows.find((r) => r.id === id);
        if (!row) return { rows: [] as TRow[] };
        row.status = 'dead';
        row.completed_at = completedAt;
        row.last_error = lastError;
        return { rows: [{ ...row }] as unknown as TRow[] };
      }

      if (text.includes("SET status = 'waiting'")) {
        const [id, availableAt] = params as [string, number];
        const row = rows.find((r) => r.id === id);
        if (!row) return { rows: [] as TRow[] };
        row.status = 'waiting';
        row.attempts = 0;
        row.available_at = availableAt;
        row.started_at = null;
        row.completed_at = null;
        return { rows: [{ ...row }] as unknown as TRow[] };
      }

      if (text.includes('WHERE id = $1 LIMIT 1')) {
        const row = rows.find((r) => r.id === params[0]);
        return { rows: (row ? [{ ...row }] : []) as unknown as TRow[] };
      }

      if (text.includes("WHERE status = 'dead'")) {
        return { rows: rows.filter((r) => r.status === 'dead').map((r) => ({ ...r })) as unknown as TRow[] };
      }

      if (text.includes('WITH stale AS')) {
        const [cutoff, currentTime] = params as [number, number];
        const reclaimed: { id: string }[] = [];
        for (const r of rows) {
          if (r.status === 'active' && r.started_at !== null && r.started_at <= cutoff) {
            if (r.attempts < r.max_attempts) {
              r.status = 'waiting';
              r.available_at = currentTime;
              r.started_at = null;
              r.completed_at = null;
            } else {
              r.status = 'dead';
              r.completed_at = currentTime;
            }
            r.last_error = r.last_error ?? 'Job exceeded visibility timeout';
            reclaimed.push({ id: r.id });
          }
        }
        return { rows: reclaimed as unknown as TRow[] };
      }

      if (text.startsWith('DELETE FROM')) {
        const statusFilter = params[0] as string | undefined;
        const removedIds: { id: string }[] = [];
        for (let i = rows.length - 1; i >= 0; i -= 1) {
          const r = rows[i]!;
          if (statusFilter === undefined || r.status === statusFilter) {
            removedIds.push({ id: r.id });
            rows.splice(i, 1);
          }
        }
        return { rows: removedIds as unknown as TRow[] };
      }

      return { rows: [] as TRow[] };
    },
  };
}

describe('@forge-fr/queue Persistent Redis & PostgreSQL Adapters', () => {
  it('supports priority enqueue, idempotency, retries, DLQ replay, and atomic worker claiming in Redis', async () => {
    let clock = 1000;
    const redis = createInMemoryRedisHarness();
    const queue = createRedisQueueAdapter(redis, {
      keyPrefix: 'test:jobs',
      now: () => clock,
      defaultBackoff: { type: 'fixed', delayMs: 50 },
    });

    await queue.connect();
    expect(await queue.ping()).toBe(true);

    const low = await queue.enqueue('email', { to: 'a@b.com' }, { priority: 50, idempotencyKey: 'dup-1' });
    const dup = await queue.enqueue('email', { to: 'a@b.com' }, { priority: 50, idempotencyKey: 'dup-1' });
    expect(dup.id).toBe(low.id);

    const high = await queue.enqueue('urgent', { ok: true }, { priority: 1, maxAttempts: 2 });

    const first = await queue.dequeue();
    expect(first?.id).toBe(high.id);
    const failed1 = await queue.fail(first!.id, new Error('transient'));
    expect(failed1.status).toBe('delayed');

    clock += 60;
    const retried = await queue.dequeue();
    expect(retried?.id).toBe(high.id);
    const failed2 = await queue.fail(retried!.id, new Error('fatal'));
    expect(failed2.status).toBe('dead');

    const dead = await queue.getDeadLetters();
    expect(dead).toHaveLength(1);
    const replayed = await queue.replayDeadLetter(high.id);
    expect(replayed.status).toBe('waiting');

    const completed: string[] = [];
    const worker = createQueueWorker(
      queue,
      async (job) => {
        completed.push(job.name);
        return 'ok';
      },
      { pollIntervalMs: 10 },
    );

    worker.start();
    await new Promise((r) => setTimeout(r, 120));
    await worker.stop();

    expect(completed.sort()).toEqual(['email', 'urgent']);
    const stats = await queue.fetchStats();
    expect(stats.completed).toBe(2);
    expect(stats.dead).toBe(0);
    await queue.disconnect();
  });

  it('rejects unsafe SQL identifiers and executes parameterized FOR UPDATE SKIP LOCKED queries in PostgreSQL', async () => {
    const sql = createFakePostgresSqlHarness();

    expect(() =>
      createPostgresQueueAdapter(sql, { tableName: 'jobs; DROP TABLE users;--' }),
    ).toThrow(QueueValidationError);

    let clock = 2000;
    const queue = createPostgresQueueAdapter(sql, {
      schemaName: 'app',
      tableName: 'worker_jobs',
      now: () => clock,
      defaultBackoff: { type: 'fixed', delayMs: 25 },
    });

    await queue.connect();
    expect(sql.statements.some((s) => s.includes('CREATE TABLE IF NOT EXISTS "app"."worker_jobs"'))).toBe(true);

    const jobA = await queue.enqueue('invoice.pdf', { invoiceId: 42 }, { idempotencyKey: 'inv-42', maxAttempts: 2 });
    const jobADup = await queue.enqueue('invoice.pdf', { invoiceId: 42 }, { idempotencyKey: 'inv-42' });
    expect(jobADup.id).toBe(jobA.id);

    const dequeued = await queue.dequeue();
    expect(dequeued?.id).toBe(jobA.id);
    expect(sql.statements.some((s) => s.includes('FOR UPDATE SKIP LOCKED'))).toBe(true);

    const retryOutcome = await queue.fail(jobA.id, 'db busy');
    expect(retryOutcome.status).toBe('delayed');

    clock += 30;
    const secondTry = await queue.dequeue();
    expect(secondTry?.attempts).toBe(2);

    const done = await queue.complete(jobA.id, { url: 's3://bucket/inv.pdf' });
    expect(done.status).toBe('completed');
    expect(await queue.fetchStats()).toEqual({
      waiting: 0,
      delayed: 0,
      active: 0,
      completed: 1,
      dead: 0,
    });
  });

  it('reclaims stale active jobs back to waiting or dead after visibilityTimeoutMs across Redis and PostgreSQL', async () => {
    let redisClock = 1_000;
    const redisQueue = createRedisQueueAdapter(createInMemoryRedisHarness(), {
      keyPrefix: 'stale:test',
      visibilityTimeoutMs: 500,
      now: () => redisClock,
    });
    await redisQueue.connect();
    await redisQueue.enqueue('stale-retry', { n: 1 }, { maxAttempts: 2 });
    await redisQueue.enqueue('stale-exhaust', { n: 2 }, { maxAttempts: 1 });

    const r1 = await redisQueue.dequeue();
    const r2 = await redisQueue.dequeue();
    expect(r1?.status).toBe('active');
    expect(r2?.status).toBe('active');

    redisClock += 600;
    const redisReclaimed = await redisQueue.reclaimStaleJobs();
    expect(redisReclaimed).toBe(2);
    expect(await redisQueue.fetchStats()).toEqual({
      waiting: 1,
      delayed: 0,
      active: 0,
      completed: 0,
      dead: 1,
    });

    let pgClock = 5_000;
    const pgQueue = createPostgresQueueAdapter(createFakePostgresSqlHarness(), {
      visibilityTimeoutMs: 500,
      now: () => pgClock,
    });
    await pgQueue.connect();
    await pgQueue.enqueue('pg-stale', { n: 1 }, { maxAttempts: 2 });
    const pgJob = await pgQueue.dequeue();
    expect(pgJob?.status).toBe('active');

    pgClock += 600;
    expect(await pgQueue.reclaimStaleJobs()).toBe(1);
    const reClaimed = await pgQueue.dequeue();
    expect(reClaimed?.id).toBe(pgJob?.id);
    expect(reClaimed?.attempts).toBe(2);
  });
});
