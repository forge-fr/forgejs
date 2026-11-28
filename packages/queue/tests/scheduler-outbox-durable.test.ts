import { describe, expect, it } from 'vitest';
import { createEventDispatcher } from '@forge-fr/core';
import {
  createUnitOfWork,
  type DatabaseAdapter,
  type DatabasePingResult,
} from '@forge-fr/database';
import { createPluginTestHarness } from '@forge-fr/testing';
import {
  QueueTokens,
  QueueValidationError,
  createDurableEventBridge,
  createJobScheduler,
  createMemoryOutboxStore,
  createMemoryQueueAdapter,
  createMemorySchedulerLockAdapter,
  createPostgresOutboxStore,
  createPostgresSchedulerLockAdapter,
  createQueuePlugin,
  createRedisSchedulerLockAdapter,
  createTransactionalOutbox,
  getNextCronTimestamp,
  matchesCronTimestamp,
  parseCronExpression,
  type PostgresQueueSqlLike,
  type RedisQueueClientLike,
} from '@forge-fr/queue';

interface MockOutboxDbRow {
  seq: number;
  id: string;
  topic: string;
  payload_json: string;
  status: 'pending' | 'processing' | 'published' | 'dead';
  priority: number;
  attempts: number;
  max_attempts: number;
  backoff_json: string | null;
  timeout_ms: number | null;
  idempotency_key: string | null;
  headers_json: string | null;
  created_at: number;
  available_at: number;
  claimed_at: number | null;
  published_at: number | null;
  last_error: string | null;
}

function createTransactionalPostgresMock() {
  let seqCounter = 0;
  let committedOutboxRows: MockOutboxDbRow[] = [];
  let committedDomainOrders: Array<{ id: string; amount: number }> = [];
  const locks = new Map<string, { owner_id: string; expires_at: number; updated_at: number }>();

  function createRunner(
    targetOutbox: () => MockOutboxDbRow[],
  ): PostgresQueueSqlLike & { insertOrder(id: string, amount: number): void } {
    return {
      insertOrder(id: string, amount: number) {
        committedDomainOrders.push({ id, amount });
      },
      async query<TRow = Record<string, unknown>>(
        text: string,
        params: readonly unknown[] = [],
      ): Promise<{ readonly rows: readonly TRow[] }> {
        const sql = text.replace(/\s+/g, ' ').trim();
        const rows = targetOutbox();

        if (sql.startsWith('CREATE TABLE') || sql.startsWith('CREATE INDEX') || sql.startsWith('CREATE UNIQUE INDEX')) {
          return { rows: [] };
        }

        // Scheduler Lock INSERT ... ON CONFLICT
        if (sql.includes('INSERT INTO') && sql.includes('lock_key')) {
          const lockKey = String(params[0]);
          const ownerId = String(params[1]);
          const expiresAt = Number(params[2]);
          const now = Number(params[3]);
          const existing = locks.get(lockKey);
          if (!existing || existing.expires_at <= now || existing.owner_id === ownerId) {
            locks.set(lockKey, { owner_id: ownerId, expires_at: expiresAt, updated_at: now });
            return { rows: [{ lock_key: lockKey } as unknown as TRow] };
          }
          return { rows: [] };
        }

        // Scheduler Lock DELETE
        if (sql.startsWith('DELETE FROM') && sql.includes('lock_key')) {
          const lockKey = String(params[0]);
          const ownerId = String(params[1]);
          const existing = locks.get(lockKey);
          if (existing && existing.owner_id === ownerId) {
            locks.delete(lockKey);
            return { rows: [{ lock_key: lockKey } as unknown as TRow] };
          }
          return { rows: [] };
        }

        // Scheduler Lock UPDATE renew
        if (sql.startsWith('UPDATE') && sql.includes('lock_key')) {
          const lockKey = String(params[0]);
          const ownerId = String(params[1]);
          const expiresAt = Number(params[2]);
          const now = Number(params[3]);
          const existing = locks.get(lockKey);
          if (existing && existing.owner_id === ownerId && existing.expires_at > now) {
            existing.expires_at = expiresAt;
            existing.updated_at = now;
            return { rows: [{ lock_key: lockKey } as unknown as TRow] };
          }
          return { rows: [] };
        }

        // Outbox idempotency lookup
        if (sql.startsWith('SELECT * FROM') && sql.includes('WHERE idempotency_key = $1')) {
          const key = String(params[0]);
          const found = rows.find(
            (r) =>
              r.idempotency_key === key &&
              (r.status === 'pending' || r.status === 'processing' || r.status === 'published'),
          );
          return { rows: found ? ([{ ...found }] as unknown as TRow[]) : [] };
        }

        // Outbox INSERT
        if (sql.startsWith('INSERT INTO') && sql.includes('topic, payload_json')) {
          seqCounter += 1;
          const row: MockOutboxDbRow = {
            seq: seqCounter,
            id: String(params[0]),
            topic: String(params[1]),
            payload_json: String(params[2]),
            status: 'pending',
            priority: Number(params[3]),
            attempts: 0,
            max_attempts: Number(params[4]),
            backoff_json: params[5] !== null ? String(params[5]) : null,
            timeout_ms: params[6] !== null ? Number(params[6]) : null,
            idempotency_key: params[7] !== null ? String(params[7]) : null,
            headers_json: params[8] !== null ? String(params[8]) : null,
            created_at: Number(params[9]),
            available_at: Number(params[10]),
            claimed_at: null,
            published_at: null,
            last_error: null,
          };
          rows.push(row);
          return { rows: [{ ...row } as unknown as TRow] };
        }

        // Outbox claimBatch (WITH next_batch AS ...)
        if (sql.startsWith('WITH next_batch AS')) {
          const nowMs = Number(params[0]);
          const limit = Number(params[1]);
          const candidates = rows
            .filter((r) => r.status === 'pending' && r.available_at <= nowMs)
            .sort((a, b) => (a.priority !== b.priority ? a.priority - b.priority : a.seq - b.seq))
            .slice(0, limit);
          const claimed: TRow[] = [];
          for (const c of candidates) {
            c.status = 'processing';
            c.attempts += 1;
            c.claimed_at = nowMs;
            claimed.push({ ...c } as unknown as TRow);
          }
          return { rows: claimed };
        }

        // Outbox markPublished
        if (sql.startsWith('UPDATE') && sql.includes("SET status = 'published'")) {
          const id = String(params[0]);
          const nowMs = Number(params[1]);
          const target = rows.find((r) => r.id === id);
          if (!target) return { rows: [] };
          target.status = 'published';
          target.published_at = nowMs;
          return { rows: [{ ...target } as unknown as TRow] };
        }

        // Outbox markFailed -> pending retry
        if (sql.startsWith('UPDATE') && sql.includes("SET status = 'pending'") && sql.includes('last_error = $3')) {
          const id = String(params[0]);
          const avail = Number(params[1]);
          const err = String(params[2]);
          const target = rows.find((r) => r.id === id);
          if (!target) return { rows: [] };
          target.status = 'pending';
          target.available_at = avail;
          target.last_error = err;
          return { rows: [{ ...target } as unknown as TRow] };
        }

        // Outbox markFailed -> dead
        if (sql.startsWith('UPDATE') && sql.includes("SET status = 'dead'")) {
          const id = String(params[0]);
          const err = String(params[1]);
          const target = rows.find((r) => r.id === id);
          if (!target) return { rows: [] };
          target.status = 'dead';
          target.last_error = err;
          return { rows: [{ ...target } as unknown as TRow] };
        }

        // Outbox replayDeadLetter
        if (sql.startsWith('UPDATE') && sql.includes('attempts = 0')) {
          const id = String(params[0]);
          const nowMs = Number(params[1]);
          const target = rows.find((r) => r.id === id);
          if (!target) return { rows: [] };
          target.status = 'pending';
          target.attempts = 0;
          target.available_at = nowMs;
          target.claimed_at = null;
          return { rows: [{ ...target } as unknown as TRow] };
        }

        // Outbox getRecord
        if (sql.startsWith('SELECT * FROM') && sql.includes('WHERE id = $1')) {
          const id = String(params[0]);
          const target = rows.find((r) => r.id === id);
          return { rows: target ? ([{ ...target }] as unknown as TRow[]) : [] };
        }

        // Outbox getDeadLetters
        if (sql.startsWith('SELECT * FROM') && sql.includes("WHERE status = 'dead'")) {
          return {
            rows: rows
              .filter((r) => r.status === 'dead')
              .map((r) => ({ ...r }) as unknown as TRow),
          };
        }

        // Outbox purgePublished
        if (sql.startsWith('DELETE FROM') && sql.includes("WHERE status = 'published'")) {
          const cutoff = Number(params[0]);
          const deleted: TRow[] = [];
          for (let i = rows.length - 1; i >= 0; i -= 1) {
            const r = rows[i]!;
            if (r.status === 'published' && (r.published_at ?? r.created_at) <= cutoff) {
              rows.splice(i, 1);
              deleted.push({ id: r.id } as unknown as TRow);
            }
          }
          return { rows: deleted };
        }

        // Outbox stats
        if (sql.startsWith('SELECT status, COUNT(*)::int AS cnt')) {
          const counts = new Map<string, number>();
          for (const r of rows) {
            counts.set(r.status, (counts.get(r.status) ?? 0) + 1);
          }
          return {
            rows: Array.from(counts.entries()).map(
              ([status, cnt]) => ({ status, cnt }) as unknown as TRow,
            ),
          };
        }

        return { rows: [] };
      },
    };
  }

  const rootRunner = createRunner(() => committedOutboxRows);

  const dbAdapter: DatabaseAdapter<typeof rootRunner, typeof rootRunner> = {
    name: 'mock-pg-outbox',
    driver: 'postgres',
    state: 'connected',
    client: rootRunner,
    async connect() {},
    async disconnect() {},
    async ping(): Promise<DatabasePingResult> {
      return { ok: true, latencyMs: 1 };
    },
    async transaction<TResult>(fn: (tx: typeof rootRunner) => Promise<TResult>): Promise<TResult> {
      const snapshotOutbox = committedOutboxRows.map((r) => ({ ...r }));
      const snapshotOrders = committedDomainOrders.map((o) => ({ ...o }));
      const txOutbox = committedOutboxRows.map((r) => ({ ...r }));
      const txRunner = createRunner(() => txOutbox);
      try {
        const res = await fn(txRunner);
        committedOutboxRows = txOutbox;
        return res;
      } catch (err) {
        // Rollback both domain orders and outbox rows atomically!
        committedOutboxRows = snapshotOutbox;
        committedDomainOrders = snapshotOrders;
        throw err;
      }
    },
  };

  return {
    rootRunner,
    dbAdapter,
    getOrders: () => committedDomainOrders,
    getOutboxRows: () => committedOutboxRows,
  };
}

describe('Milestone 7 — Background Job Scheduler, Transactional Outbox & Durable Events (@forge-fr/queue, Part 15)', () => {
  it('parses 5-field, 6-field, and macro cron expressions and computes timezone-aware schedules (UTC, Asia/Jakarta, America/New_York)', () => {
    const parsed5 = parseCronExpression('*/15 9-17 * * MON-FRI');
    expect(parsed5.hasSeconds).toBe(false);
    expect(Array.from(parsed5.minutes)).toEqual([0, 15, 30, 45]);
    expect(Array.from(parsed5.daysOfWeek)).toEqual([1, 2, 3, 4, 5]);

    const parsed6 = parseCronExpression('30 0 8 1 JAN-DEC/3 *');
    expect(parsed6.hasSeconds).toBe(true);
    expect(Array.from(parsed6.seconds)).toEqual([30]);
    expect(Array.from(parsed6.months)).toEqual([1, 4, 7, 10]);

    const dailyMacro = parseCronExpression('@daily');
    expect(Array.from(dailyMacro.minutes)).toEqual([0]);
    expect(Array.from(dailyMacro.hours)).toEqual([0]);

    // 2026-01-05T01:59:00.000Z is Monday 08:59 WIB in Asia/Jakarta (UTC+7)
    const baseMs = Date.parse('2026-01-05T01:59:00.000Z');
    const nextJakarta9Am = getNextCronTimestamp('0 9 * * MON', baseMs, 'Asia/Jakarta');
    // 09:00 Asia/Jakarta on 2026-01-05 is 02:00:00.000Z
    expect(new Date(nextJakarta9Am).toISOString()).toBe('2026-01-05T02:00:00.000Z');
    expect(matchesCronTimestamp('0 9 * * MON', nextJakarta9Am, 'Asia/Jakarta')).toBe(true);
    expect(matchesCronTimestamp('0 9 * * MON', nextJakarta9Am, 'UTC')).toBe(false);

    expect(() => parseCronExpression('invalid cron')).toThrow(QueueValidationError);
    expect(() => getNextCronTimestamp('* * * * *', baseMs, 'Invalid/Timezone_Name')).toThrow(
      QueueValidationError,
    );
  });

  it('prevents duplicate scheduled job execution across multi-node replicas using distributed lease locking and idempotent tick keys', async () => {
    let now = Date.parse('2026-03-01T10:00:00.000Z');
    const queue = createMemoryQueueAdapter({ now: () => now });
    await queue.connect();

    // Shared distributed lock adapter across 3 concurrent scheduler replicas
    const sharedMemoryLocks = createMemorySchedulerLockAdapter({ now: () => now });

    const createReplica = (nodeId: string) =>
      createJobScheduler({
        nodeId,
        queue,
        lockAdapter: sharedMemoryLocks,
        now: () => now,
        schedules: [
          {
            id: 'billing.invoice-rollup',
            cron: '*/5 * * * *',
            timezone: 'UTC',
            payload: (ctx) => ({
              slot: ctx.slotTimestampMs,
              tickKey: ctx.tickKey,
            }),
          },
          {
            id: 'metrics.heartbeat',
            everyMs: 60_000,
            payload: { source: 'scheduler' },
          },
        ],
      });

    const nodeA = createReplica('scheduler-node-a');
    const nodeB = createReplica('scheduler-node-b');
    const nodeC = createReplica('scheduler-node-c');

    // Before first 1-minute / 5-minute slot is due -> 0 jobs enqueued
    now = Date.parse('2026-03-01T10:00:30.000Z');
    const earlyTick = await nodeA.tick(now);
    expect(earlyTick.enqueued).toBe(0);
    expect(earlyTick.skippedNotDue).toBe(2);

    // Advance clock to 10:05:00.000Z (both 5-min cron AND 60s interval are due!)
    now = Date.parse('2026-03-01T10:05:00.000Z');

    // All 3 replicas tick at the exact same timestamp
    const [resA, resB, resC] = await Promise.all([
      nodeA.tick(now),
      nodeB.tick(now),
      nodeC.tick(now),
    ]);

    const totalEnqueued = resA.enqueued + resB.enqueued + resC.enqueued;
    const totalSkippedLocked = resA.skippedLocked + resB.skippedLocked + resC.skippedLocked;

    // Exactly 2 jobs enqueued total (1 for billing.invoice-rollup, 1 for metrics.heartbeat); the other 2 replicas skipped both via lease locks!
    expect(totalEnqueued).toBe(2);
    expect(totalSkippedLocked).toBe(4);
    expect(queue.stats().waiting).toBe(2);

    // Also verify Redis and PostgreSQL distributed lock adapters
    const redisStore = new Map<string, { value: string; expiresAt: number }>();
    const mockRedisClient: RedisQueueClientLike = {
      async ping() {
        return 'PONG';
      },
      async get(key) {
        const entry = redisStore.get(key);
        if (!entry || entry.expiresAt <= now) return null;
        return entry.value;
      },
      async set(key, value, ...args) {
        const hasNx = args.includes('NX');
        const pxIdx = args.indexOf('PX');
        const ttl = pxIdx >= 0 ? Number(args[pxIdx + 1]) : 60_000;
        const existing = redisStore.get(key);
        if (hasNx && existing && existing.expiresAt > now) {
          return null;
        }
        redisStore.set(key, { value, expiresAt: now + ttl });
        return 'OK';
      },
      async del(...keys) {
        let count = 0;
        for (const k of keys) {
          if (redisStore.delete(k)) count += 1;
        }
        return count;
      },
      async zadd() {
        return 1;
      },
      async zrem() {
        return 1;
      },
      async zrangebyscore() {
        return [];
      },
      async zcard() {
        return 0;
      },
    };

    const redisLocks = createRedisSchedulerLockAdapter(mockRedisClient);
    expect(await redisLocks.acquire('slot:1', 'node-1', 10_000, now)).toBe(true);
    expect(await redisLocks.acquire('slot:1', 'node-2', 10_000, now)).toBe(false);
    expect(await redisLocks.renew?.('slot:1', 'node-1', 20_000, now)).toBe(true);
    expect(await redisLocks.release('slot:1', 'node-2')).toBe(false);
    expect(await redisLocks.release('slot:1', 'node-1')).toBe(true);

    const pgMock = createTransactionalPostgresMock();
    const pgLocks = createPostgresSchedulerLockAdapter(pgMock.rootRunner, { now: () => now });
    await pgLocks.ensureSchema();
    expect(await pgLocks.acquire('pg-slot:1', 'node-1', 10_000, now)).toBe(true);
    expect(await pgLocks.acquire('pg-slot:1', 'node-2', 10_000, now)).toBe(false);
    // Advance clock past lease expiry -> node-2 can now acquire expired lease!
    now += 15_000;
    expect(await pgLocks.acquire('pg-slot:1', 'node-2', 10_000, now)).toBe(true);
    expect(await pgLocks.release('pg-slot:1', 'node-2')).toBe(true);
  });

  it('guarantees Transactional Outbox commit-vs-rollback atomicity with UnitOfWork (Memory & PostgreSQL) and relays committed events with retry/DLQ', async () => {
    let now = 50_000;
    const queue = createMemoryQueueAdapter({ now: () => now });
    await queue.connect();

    const emittedEvents: Array<{ orderId: string; total: number }> = [];
    const events = createEventDispatcher<{
      'order.created': { readonly orderId: string; readonly total: number };
    }>();
    events.on('order.created', (payload) => {
      emittedEvents.push(payload);
    });

    // 1. Test PostgreSQL Transactional Outbox + UnitOfWork commit vs rollback atomicity
    const pgMock = createTransactionalPostgresMock();
    const uow = createUnitOfWork(pgMock.dbAdapter);
    const pgOutbox = createTransactionalOutbox({
      sql: pgMock.rootRunner,
      queue,
      events,
      defaultMaxAttempts: 2,
      defaultBackoff: { type: 'fixed', delayMs: 1_000 },
      now: () => now,
    });
    await pgOutbox.ensureSchema();

    // Rolled-back transaction: both domain insert AND outbox insert MUST roll back atomically!
    await expect(
      uow.run(async (txCtx) => {
        txCtx.tx.insertOrder('ord_rollback', 199);
        await pgOutbox.enqueue(
          'order.created',
          { orderId: 'ord_rollback', total: 199 },
          { tx: txCtx, idempotencyKey: 'outbox:ord_rollback' },
        );
        throw new Error('Simulated credit card decline');
      }),
    ).rejects.toThrow('Simulated credit card decline');

    expect(pgMock.getOrders()).toHaveLength(0);
    expect(pgMock.getOutboxRows()).toHaveLength(0);
    const emptyRelay = await pgOutbox.relayBatch();
    expect(emptyRelay.claimed).toBe(0);
    expect(queue.stats().waiting).toBe(0);
    expect(emittedEvents).toHaveLength(0);

    // Committed transaction: both domain insert AND outbox record commit together!
    await uow.run(async (txCtx) => {
      txCtx.tx.insertOrder('ord_committed', 450);
      await pgOutbox.enqueue(
        'order.created',
        { orderId: 'ord_committed', total: 450 },
        { tx: txCtx, idempotencyKey: 'outbox:ord_committed' },
      );
    });

    expect(pgMock.getOrders()).toEqual([{ id: 'ord_committed', amount: 450 }]);
    expect((await pgOutbox.stats()).pending).toBe(1);

    // Relay forwards committed outbox record to both QueueAdapter and EventDispatcher
    const relayRes = await pgOutbox.relayBatch();
    expect(relayRes.claimed).toBe(1);
    expect(relayRes.published).toBe(1);
    expect(queue.stats().waiting).toBe(1);
    expect(emittedEvents).toEqual([{ orderId: 'ord_committed', total: 450 }]);
    expect((await pgOutbox.stats()).published).toBe(1);

    const purgedCount = await pgOutbox.purgePublished();
    expect(purgedCount).toBe(1);

    // 2. Test MemoryOutboxStore commit-vs-rollback via TransactionContext.afterCommit/afterRollback + relay retry/DLQ
    let shouldFailPublisher = true;
    const publishedPayloads: unknown[] = [];
    const memOutbox = createTransactionalOutbox({
      store: createMemoryOutboxStore({ now: () => now }),
      publisher: async (rec) => {
        if (shouldFailPublisher) {
          throw new Error('Broker temporarily unreachable');
        }
        publishedPayloads.push(rec.payload);
      },
      defaultMaxAttempts: 2,
      defaultBackoff: { type: 'fixed', delayMs: 500 },
      now: () => now,
    });

    // Rollback in UnitOfWork discards staged memory outbox event
    await expect(
      uow.run(async (txCtx) => {
        await memOutbox.enqueue('user.deleted', { userId: 'u_rolled_back' }, { tx: txCtx });
        throw new Error('Abort transaction');
      }),
    ).rejects.toThrow('Abort transaction');
    expect((await memOutbox.stats()).pending).toBe(0);

    // Commit in UnitOfWork flushes staged memory outbox event
    await uow.run(async (txCtx) => {
      await memOutbox.enqueue('user.deleted', { userId: 'u_committed' }, { tx: txCtx });
    });
    expect((await memOutbox.stats()).pending).toBe(1);

    // Attempt 1 fails -> scheduled for retry at now + 500ms
    const failRelay1 = await memOutbox.relayBatch({ nowMs: now });
    expect(failRelay1.retried).toBe(1);
    expect(failRelay1.deadLettered).toBe(0);

    // Attempt 2 at now + 500ms fails -> reaches maxAttempts (2) -> moves to dead!
    now += 500;
    const failRelay2 = await memOutbox.relayBatch({ nowMs: now });
    expect(failRelay2.deadLettered).toBe(1);
    const deadRecords = await memOutbox.getDeadLetters();
    expect(deadRecords).toHaveLength(1);
    expect(deadRecords[0]!.lastError).toBe('Broker temporarily unreachable');

    // Recover broker and replay dead-letter outbox record
    shouldFailPublisher = false;
    await memOutbox.replayDeadLetter(deadRecords[0]!.id);
    const recoveredRelay = await memOutbox.relayBatch({ nowMs: now });
    expect(recoveredRelay.published).toBe(1);
    expect(publishedPayloads).toEqual([{ userId: 'u_committed' }]);
  });

  it('connects EventDispatcher topics to durable queue jobs with retry, DLQ inspection, and replay via createDurableEventBridge', async () => {
    interface DomainEvents extends Record<string, unknown> {
      'user.welcome-email': { readonly userId: string; readonly email: string };
      'audit.logged': { readonly action: string };
    }

    let now = 100_000;
    const queue = createMemoryQueueAdapter({
      defaultMaxAttempts: 2,
      defaultBackoff: { type: 'fixed', delayMs: 0 },
      now: () => now,
    });
    await queue.connect();

    const events = createEventDispatcher<DomainEvents>();
    const deliveredEmails: Array<{ userId: string; email: string; attempt: number }> = [];
    let failEmailDelivery = true;

    const bridge = createDurableEventBridge<DomainEvents>({
      queue,
      events,
      now: () => now,
      topics: {
        'user.welcome-email': {
          enqueueOptions: { maxAttempts: 2, backoff: { type: 'fixed', delayMs: 0 } },
          idempotencyKey: (p) => `welcome:${p.userId}`,
          handler: async (payload, ctx) => {
            if (failEmailDelivery) {
              throw new Error(`SMTP timeout for ${payload.email}`);
            }
            deliveredEmails.push({
              userId: payload.userId,
              email: payload.email,
              attempt: ctx.attempt,
            });
          },
        },
      },
    });

    // Emit event on EventDispatcher -> automatically enqueues durable job with idempotency protection
    await events.emit('user.welcome-email', { userId: 'u_100', email: 'andi@forgejs.id' });
    await events.emit('user.welcome-email', { userId: 'u_100', email: 'andi@forgejs.id' }); // duplicate deduplicated!
    expect(queue.stats().waiting).toBe(1);

    const worker = bridge.createWorker({ pollIntervalMs: 5 });
    worker.start();

    // Wait for 2 failed attempts to move the job to Dead-Letter Queue
    for (let i = 0; i < 40 && queue.stats().dead === 0; i += 1) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(queue.stats().dead).toBe(1);

    const deadEvents = await bridge.getDeadLetterEvents('user.welcome-email');
    expect(deadEvents).toHaveLength(1);
    expect(deadEvents[0]!.payload.data).toEqual({
      userId: 'u_100',
      email: 'andi@forgejs.id',
    });

    // Restore SMTP and replay dead-lettered durable event
    failEmailDelivery = false;
    await bridge.replayAllDeadLetterEvents('user.welcome-email');

    for (let i = 0; i < 40 && queue.stats().completed === 0; i += 1) {
      await new Promise((r) => setTimeout(r, 10));
    }

    await worker.stop();
    expect(deliveredEmails).toEqual([
      { userId: 'u_100', email: 'andi@forgejs.id', attempt: 1 },
    ]);

    // Also verify createQueuePlugin DI wiring for Scheduler, Outbox, and DurableEventBridge
    const scheduler = createJobScheduler({ queue, now: () => now });
    const outbox = createTransactionalOutbox({ queue, now: () => now });
    const harness = createPluginTestHarness({
      plugin: createQueuePlugin({
        queue,
        scheduler,
        outbox,
        durableEvents: bridge,
      }),
    });

    await harness.start();
    expect(harness.resolveExport(QueueTokens.Scheduler)).toBe(scheduler);
    expect(harness.resolveExport(QueueTokens.Outbox)).toBe(outbox);
    expect(harness.resolveExport(QueueTokens.DurableEventBridge)).toBe(bridge);
    expect(scheduler.running).toBe(true);
    expect(outbox.relaying).toBe(true);

    await harness.shutdown();
    expect(scheduler.running).toBe(false);
    expect(outbox.relaying).toBe(false);
  });
});
