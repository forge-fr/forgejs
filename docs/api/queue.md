# @forge-fr/queue

> Background job queues, cron/interval createJobScheduler with distributed lease locks, createTransactionalOutbox, and createDurableEventBridge for Memory, Redis, and PostgreSQL.

- **Version**: v1.0.0
- **Layer**: Infrastructure
- **Category**: infrastructure
- **Tarball**: 25.1 kB (40 files)
- **Internal deps**: @forge-fr/core
- **Runtime deps**: zero runtime dependencies
- **Peer deps**: none
- **HTML URL**: https://github.com/forge-fr/forgejs/api/queue
- **Markdown URL**: https://github.com/forge-fr/forgejs/api/queue.md

## Installation

```bash
# Add once to .npmrc: @forge-fr:registry=https://npm.pkg.github.com
npm install @forge-fr/queue
```

## Plugin Metadata

- **Factory**: `createQueuePlugin`
- **Tokens**: `QueueTokens`
- **Health probe**: `queue`
- **Capabilities**: `di:register`, `health:register`

## Runtime & Error Semantics

- **Runtime**: Zero third-party runtime dependencies. Duck-typed clients support Memory, Redis (Lua pop), and PostgreSQL (FOR UPDATE SKIP LOCKED).
- **Errors**: Enforces payload size limits (QueueValidationError), bounded queues (QueueFullError), exponential backoff retries, and DLQ replay.

## Usage Example

```ts
import { createMemoryQueueAdapter, createQueueWorker } from '@forge-fr/queue';

const queue = createMemoryQueueAdapter();
const worker = createQueueWorker(queue, async (job) => {
  console.info('Processed', job.name, job.payload);
});
await queue.enqueue('email.welcome', { userId: 'u_1' });
```

## Public Exports

### Queue Adapters, Workers & Plugin

- **Values**: `QueueError`, `QueueFullError`, `QueueValidationError`, `assertPayloadSizeLimit`, `computeBackoffDelayMs`, `sanitizePayload`, `validateIdempotencyKey`, `validateJobName`, `createMemoryQueueAdapter`, `createRedisQueueAdapter`, `createPostgresQueueAdapter`, `createQueueWorker`, `QueueTokens`, `createQueuePlugin`
- **Types**: `BackoffPolicy`, `EnqueueOptions`, `FailJobOutcome`, `JobExecutionContext`, `JobHandler`, `JobStatus`, `MemoryQueueOptions`, `PersistentQueueAdapter`, `PostgresQueryResult`, `PostgresQueueAdapter`, `PostgresQueueOptions`, `PostgresQueueSqlLike`, `QueueAdapter`, `QueueJob`, `QueuePluginOptions`, `QueueStats`, `QueueWorker`, `QueueWorkerOptions`, `QueueWorkerStopOptions`, `RedisQueueClientLike`, `RedisQueueOptions`

### Job Scheduler, Transactional Outbox & Durable Events

- **Values**: `createJobScheduler`, `createMemorySchedulerLockAdapter`, `createPostgresSchedulerLockAdapter`, `createRedisSchedulerLockAdapter`, `getNextCronTimestamp`, `matchesCronTimestamp`, `parseCronExpression`, `validateTimezone`, `createMemoryOutboxStore`, `createPostgresOutboxStore`, `createTransactionalOutbox`, `createDurableEventBridge`
- **Types**: `JobScheduler`, `JobSchedulerOptions`, `MemorySchedulerLockOptions`, `MemorySchedulerLockStore`, `ParsedCronExpression`, `PostgresSchedulerLockAdapter`, `PostgresSchedulerLockOptions`, `RedisSchedulerLockOptions`, `RegisteredScheduleInfo`, `ScheduledJobDefinition`, `ScheduledJobTickContext`, `SchedulerLockAdapter`, `SchedulerTickResult`, `MemoryOutboxStore`, `MemoryOutboxStoreOptions`, `OutboxBatchEntry`, `OutboxEnqueueOptions`, `OutboxPublisher`, `OutboxRecord`, `OutboxRelayResult`, `OutboxStats`, `OutboxStatus`, `OutboxStoreAdapter`, `OutboxStoreInsertInput`, `OutboxTransactionContextLike`, `OutboxTransactionHandle`, `PostgresOutboxStoreOptions`, `TransactionalOutbox`, `TransactionalOutboxOptions`, `DurableEventBridge`, `DurableEventBridgeOptions`, `DurableEventConsumer`, `DurableEventExecutionContext`, `DurableEventJobPayload`, `DurableEventPublishOptions`, `DurableEventTopicConfig`, `DurableEventTopicRule`
