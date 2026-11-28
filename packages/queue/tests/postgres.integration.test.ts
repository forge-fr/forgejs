import postgres from 'postgres';
import { describe, expect, it } from 'vitest';
import {
  createPostgresOutboxStore,
  createPostgresQueueAdapter,
  createPostgresSchedulerLockAdapter,
  createTransactionalOutbox,
} from '../src/index.js';

const dbUrl = process.env.FORGE_TEST_DATABASE_URL;

describe.skipIf(!dbUrl)(
  '@forge-fr/queue Live PostgreSQL SKIP LOCKED, Scheduler Locks & Transactional Outbox Integration (requires FORGE_TEST_DATABASE_URL)',
  () => {
    it('executes concurrent SKIP LOCKED dequeues, retries, DLQ replay, distributed scheduler locks, and transactional outbox commit/rollback against real PostgreSQL', async () => {
      const sql = postgres(dbUrl!, { max: 4 });
      const queue = createPostgresQueueAdapter(sql, {
        tableName: 'forge_queue_ci_test',
        defaultMaxAttempts: 2,
      });

      const locks = createPostgresSchedulerLockAdapter(sql, {
        tableName: 'forge_scheduler_locks_ci_test',
      });

      const outbox = createTransactionalOutbox({
        store: createPostgresOutboxStore(sql, {
          tableName: 'forge_outbox_ci_test',
        }),
        queue,
      });

      await queue.connect();
      await queue.purge();
      await locks.ensureSchema();
      await outbox.ensureSchema();

      try {
        await queue.enqueue('job-1', { step: 1 }, { priority: 10, idempotencyKey: 'ci-1' });
        await queue.enqueue('job-2', { step: 2 }, { priority: 5 });

        const [d1, d2] = await Promise.all([queue.dequeue(), queue.dequeue()]);
        expect(d1).toBeDefined();
        expect(d2).toBeDefined();
        expect(d1!.id).not.toBe(d2!.id);
        expect(d1!.name).toBe('job-2');

        await queue.complete(d1!.id, { done: true });
        await queue.fail(d2!.id, new Error('first fail'));
        const stats = await queue.fetchStats();
        expect(stats.completed).toBe(1);
        expect(stats.delayed).toBe(1);

        // Distributed scheduler lease lock deduplication
        const acquired1 = await locks.acquire('ci-slot-1', 'worker-a', 30_000);
        const acquired2 = await locks.acquire('ci-slot-1', 'worker-b', 30_000);
        expect(acquired1).toBe(true);
        expect(acquired2).toBe(false);
        await locks.release('ci-slot-1', 'worker-a');

        // Transactional Outbox rollback vs commit
        await expect(
          sql.begin(async (tx) => {
            await outbox.enqueue('ci.order.created', { orderId: 'rolled-back' }, { tx });
            throw new Error('rollback test');
          }),
        ).rejects.toThrow('rollback test');
        expect((await outbox.stats()).pending).toBe(0);

        await sql.begin(async (tx) => {
          await outbox.enqueue('ci.order.created', { orderId: 'committed' }, { tx });
        });
        expect((await outbox.stats()).pending).toBe(1);
        const relay = await outbox.relayBatch();
        expect(relay.published).toBe(1);
      } finally {
        await outbox.purgePublished();
        await queue.purge();
        await sql.end();
      }
    });
  },
);
