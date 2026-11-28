# Queues & Background Jobs

> Run background jobs with Memory, Redis, or PostgreSQL drivers, automatic retries, dead-letter replay, and clean worker shutdown.

- **Section**: Advanced Features
- **Packages**: @forge-fr/queue
- **Version**: v1.0.0
- **Updated**: 2026-11-27
- **HTML URL**: https://github.com/forge-fr/forgejs/docs/advanced/queues
- **Markdown URL**: https://github.com/forge-fr/forgejs/docs/advanced/queues.md
- **Source**: https://github.com/forge-fr/forgejs/blob/main/docs/infrastructure-and-cli.md

## Queue jobs and stop workers cleanly

@forge-fr/queue gives you the same API across createMemoryQueueAdapter(), createRedisQueueAdapter() (atomic Lua pop), and createPostgresQueueAdapter() (using PostgreSQL FOR UPDATE SKIP LOCKED).

**File: `src/worker.ts`**

```ts
import { createMemoryQueueAdapter, createQueueWorker } from '@forge-fr/queue';

const queue = createMemoryQueueAdapter({ maxQueueSize: 1_000 });

const worker = createQueueWorker<{ invoiceId: string }>(
  queue,
  async (job, ctx) => {
    if (ctx.signal.aborted) return;
    console.info('Rendering PDF for', job.payload.invoiceId);
  },
  { pollIntervalMs: 25, concurrency: 4 },
);

worker.start();
await queue.enqueue(
  'invoice.pdf',
  { invoiceId: 'inv_99' },
  { idempotencyKey: 'inv_99', priority: 10 },
);

// On SIGTERM, wait for active jobs to finish cleanly:
await worker.stop({ timeoutMs: 5_000 });
```

## Retries, backoff & Dead-Letter Queue (DLQ)

- Failed jobs automatically retry with increasing delays up to maxAttempts, then move to the Dead-Letter Queue.
- Inspect or re-run failed jobs anytime with adapter.listDeadLetters() and adapter.replayDeadLetter(id).
- Note: ForgeJS includes background job queues, not a built-in cron scheduler.
