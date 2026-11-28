# Changelog — @forge-fr/database

## [1.0.0] - 2026-11-27

### Added & Changed
- Added `UnitOfWork<TTx>` (`createUnitOfWork`, `uow.run()`), `TransactionContext<TTx>` (`.afterCommit()`, `.afterRollback()`), `defineRepository()`, and lazy dynamic `postgres` driver loading for Edge bundle portability.

## [0.1.0] — Phase 4 Milestone 4.1 (2026-11-25)

- Initial release of `@forge-fr/database`:
  - Normalized database error taxonomy (`DatabaseError`, `DatabaseConnectionError`, `DatabaseUniqueViolationError`, `DatabaseForeignKeyViolationError`, `DatabaseNotNullViolationError`, `DatabaseCheckViolationError`, `DatabaseSerializationError`, `DatabaseTimeoutError`) with PostgreSQL SQLSTATE + network error mapping (`normalizeDatabaseError`) and credential redaction (`redactDatabaseUrl`).
  - Core `DatabaseAdapter<TClient, TTxClient>` contract, `runInTransaction()` helper, and `createMigrationCoordinator()` with deterministic ordering, checksum tracking, and hooks (`beforeMigrate`, `afterMigrate`, `beforeRollback`, `afterRollback`).
  - First-class ForgeJS plugin factories (`createDatabasePlugin`, `createPostgresPlugin`) with capability-scoped DI exports (`di:register`) and live `kernel.health` checks (`health:register`).
  - Native PostgreSQL (`postgres-js`) adapter (`createPostgresAdapter`) supporting `SecretValue` URLs, Standard Schema v1 config validation, strict isolation-level allowlist transactions, `ping()` health probes, and graceful pool drain on shutdown.
