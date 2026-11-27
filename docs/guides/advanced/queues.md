# Queues & Background Jobs

> Memory, Redis sorted-set (atomic Lua pop), and PostgreSQL SKIP LOCKED job queues with retries, idempotency keys, DLQ replay, and graceful worker drain.

- **Section**: Advanced Features
- **Packages**: @forge-fr/queue
- **Version**: v1.0.0-rc.2
- **Updated**: 2026-11-26
- **HTML URL**: https://github.com/forge-fr/forgejs/docs/advanced/queues
- **Markdown URL**: https://github.com/forge-fr/forgejs/docs/advanced/queues.md
- **Source**: https://github.com/forge-fr/forgejs/blob/main/docs/infrastructure-and-cli.md

## Enqueueing jobs & draining workers gracefully

@forge-fr/queue provides identical job semantics across createMemoryQueueAdapter(), createRedisQueueAdapter() (atomic Lua pop), and createPostgresQueueAdapter() (PostgreSQL FOR UPDATE SKIP LOCKED).

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

## Retries, exponential backoff & Dead-Letter Queue (DLQ)

- Failed jobs retry with bounded exponential backoff up to maxAttempts before moving to the Dead-Letter Queue.
- Inspect or replay dead-letter jobs programmatically via adapter.listDeadLetters() and adapter.replayDeadLetter(id).
- Note: ForgeJS ships durable job queues, not a built-in cron scheduler.
