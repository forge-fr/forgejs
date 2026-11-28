# Changelog

## 0.1.0 (2026-11-25)

- Initial release of `@forge-fr/queue`:
  - `QueueAdapter` & `QueueWorker` contracts with prototype-safe payload isolation and strict queue/job naming.
  - Bounded `createMemoryQueueAdapter()` supporting delayed jobs, priority ordering, idempotency key deduplication, backoff retries, and dead-letter storage/replay.
  - `createQueueWorker()` with concurrency control, per-job `AbortSignal` timeout enforcement, lifecycle callbacks, and graceful shutdown draining.
  - `createQueuePlugin()` and `QueueTokens` for ForgeJS DI, health checks, and shutdown draining.

## [1.0.0] - 2026-11-27

### Added & Changed
- Added `createJobScheduler()` (5/6-field cron + IANA timezones + Memory/Redis/Postgres lease locks), `createTransactionalOutbox()` (`createMemoryOutboxStore`, `createPostgresOutboxStore`), and `createDurableEventBridge()` with DLQ replay.

