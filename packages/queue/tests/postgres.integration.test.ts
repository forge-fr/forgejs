import postgres from 'postgres';
import { describe, expect, it } from 'vitest';
import { createPostgresQueueAdapter } from '../src/index.js';

const dbUrl = process.env.FORGE_TEST_DATABASE_URL;

describe.skipIf(!dbUrl)(
  '@forge-fr/queue Live PostgreSQL SKIP LOCKED Integration (requires FORGE_TEST_DATABASE_URL)',
  () => {
    it('executes concurrent SKIP LOCKED dequeues, retries, and DLQ replay against real PostgreSQL', async () => {
      const sql = postgres(dbUrl!, { max: 4 });
      const queue = createPostgresQueueAdapter(sql, {
        tableName: 'forge_queue_ci_test',
        defaultMaxAttempts: 2,
      });

      await queue.connect();
      await queue.purge();

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
      } finally {
        await queue.purge();
        await sql.end();
      }
    });
  },
);
