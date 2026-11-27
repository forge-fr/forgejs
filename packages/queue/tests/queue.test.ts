import { createPluginTestHarness } from '@forge-fr/testing';
import { describe, expect, it } from 'vitest';
import {
  QueueFullError,
  QueueTokens,
  QueueValidationError,
  createMemoryQueueAdapter,
  createQueuePlugin,
  createQueueWorker,
} from '@forge-fr/queue';

describe('@forge-fr/queue — Background Jobs, Backoff Retries, DLQ, Timeouts & Worker Draining', () => {
  it('enforces queue capacity, deduplicates idempotency keys, orders by priority, and strips poisoned payload keys', async () => {
    const queue = createMemoryQueueAdapter({ maxQueueSize: 3 });
    await queue.connect();

    const jLow = await queue.enqueue('email.send', { to: 'low@example.com' }, { priority: 10 });
    const poisoned = JSON.parse('{"to":"hi@example.com","__proto__":{"admin":true}}');
    const jHigh = await queue.enqueue('email.send', poisoned, {
      priority: 1,
      idempotencyKey: 'welcome:u1',
    });
    // Duplicate idempotencyKey returns existing non-terminal job without consuming extra slot
    const jDup = await queue.enqueue(
      'email.send',
      { to: 'hi@example.com' },
      { idempotencyKey: 'welcome:u1' },
    );
    expect(jDup.id).toBe(jHigh.id);
    expect(Object.prototype.hasOwnProperty.call(jHigh.payload, '__proto__')).toBe(false);

    await queue.enqueue('email.send', { to: 'mid@example.com' }, { priority: 5 });
    // Queue now has 3 jobs -> 4th must trigger QueueFullError
    await expect(queue.enqueue('email.send', { to: 'overflow@example.com' })).rejects.toThrow(
      QueueFullError,
    );

    // Invalid job name rejected
    await expect(queue.enqueue('bad job name!', {})).rejects.toThrow(QueueValidationError);

    const dequeuedOrder: string[] = [];
    const worker = createQueueWorker(queue, async (job) => {
      dequeuedOrder.push(job.id);
    }, { pollIntervalMs: 5 });

    worker.start();
    await new Promise((r) => setTimeout(r, 80));
    await worker.stop();

    expect(dequeuedOrder[0]).toBe(jHigh.id);
    expect(dequeuedOrder[2]).toBe(jLow.id);
    expect(queue.stats().completed).toBe(3);

    await queue.disconnect();
  });

  it('retries failed jobs with backoff, moves exhausted jobs to DLQ, supports replayDeadLetter, and enforces per-job timeout + graceful drain', async () => {
    const queue = createMemoryQueueAdapter();
    await queue.connect();

    let flakyAttempts = 0;
    let permanentlyDeadId = '';
    const deadLettersSeen: string[] = [];

    const dlqJob = await queue.enqueue(
      'webhook.deliver',
      { url: 'https://example.com/hook' },
      {
        maxAttempts: 2,
        backoff: { type: 'exponential', delayMs: 10, maxDelayMs: 25, jitter: false },
      },
    );
    permanentlyDeadId = dlqJob.id;

    let abortObserved = false;
    const timeoutJob = await queue.enqueue(
      'report.slow',
      { reportId: 'r1' },
      { maxAttempts: 1, timeoutMs: 25 },
    );

    const worker = createQueueWorker(
      queue,
      async (job, ctx) => {
        if (job.name === 'webhook.deliver') {
          flakyAttempts += 1;
          if (flakyAttempts <= 2) {
            throw new Error('502 Bad Gateway');
          }
          return { delivered: true };
        }
        if (job.name === 'report.slow') {
          await new Promise<void>((resolve, reject) => {
            const t = setTimeout(resolve, 500);
            ctx.signal.addEventListener('abort', () => {
              abortObserved = true;
              clearTimeout(t);
              reject(new Error('Aborted'));
            });
          });
        }
        return undefined;
      },
      {
        pollIntervalMs: 5,
        concurrency: 2,
        onDeadLetter(job) {
          deadLettersSeen.push(job.id);
        },
      },
    );

    worker.start();
    await new Promise((r) => setTimeout(r, 150));
    await worker.stop({ timeoutMs: 1000 });

    expect(abortObserved).toBe(true);
    expect(deadLettersSeen).toContain(permanentlyDeadId);
    expect(deadLettersSeen).toContain(timeoutJob.id);

    const dlq = await queue.getDeadLetters();
    expect(dlq.map((j) => j.id)).toContain(permanentlyDeadId);

    // Replay dead letter; next attempt (3rd total execution) succeeds!
    const replayed = await queue.replayDeadLetter(permanentlyDeadId);
    expect(replayed.status).toBe('waiting');

    worker.start();
    await new Promise((r) => setTimeout(r, 80));
    await worker.stop();

    const finished = await queue.getJob(permanentlyDeadId);
    expect(finished?.status).toBe('completed');
    expect(flakyAttempts).toBe(3);

    await queue.disconnect();
  });

  it('integrates with ForgeJS DI, HealthRegistry, and drains in-flight worker jobs during kernel shutdown', async () => {
    const queue = createMemoryQueueAdapter();
    let inFlightFinished = false;
    let releaseWork!: () => void;
    const workStarted = new Promise<void>((resolve) => {
      releaseWork = resolve;
    });

    const worker = createQueueWorker(
      queue,
      async () => {
        releaseWork();
        await new Promise((r) => setTimeout(r, 40));
        inFlightFinished = true;
      },
      { pollIntervalMs: 5 },
    );

    const harness = createPluginTestHarness({
      plugin: createQueuePlugin({ queue, worker, drainTimeoutMs: 1000 }),
    });
    await harness.start();

    const injectedQueue = harness.resolveExport(QueueTokens.Queue);
    await injectedQueue.enqueue('invoice.sync', { id: 'inv_9' });

    await workStarted;
    const health = await harness.health();
    expect(health.status).toBe('ok');
    expect(health.checks['queue']?.status).toBe('ok');

    // Shutdown waits for in-flight job to complete cleanly
    await harness.shutdown();
    expect(inFlightFinished).toBe(true);
  });
});
