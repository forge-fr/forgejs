export {
  DatabaseCheckViolationError,
  DatabaseConnectionError,
  DatabaseError,
  DatabaseForeignKeyViolationError,
  DatabaseNotNullViolationError,
  DatabaseSerializationError,
  DatabaseTimeoutError,
  DatabaseUniqueViolationError,
  normalizeDatabaseError,
  redactDatabaseUrl,
  type DatabaseErrorOptions,
} from './errors.js';

export {
  DefaultDatabaseTokens,
  createDatabaseToken,
  runInTransaction,
  type DatabaseAdapter,
  type DatabaseConnectionState,
  type DatabasePingResult,
  type DatabaseTokens,
  type TransactionIsolationLevel,
  type TransactionOptions,
} from './types.js';

export {
  MigrationChecksumError,
  MigrationRollbackError,
  createMigrationCoordinator,
  type Migration,
  type MigrationCoordinator,
  type MigrationCoordinatorOptions,
  type MigrationHooks,
  type MigrationRecord,
  type MigrationRunResult,
  type MigrationStateStore,
} from './migrations.js';

export { createDatabasePlugin, type DatabasePluginOptions } from './plugin.js';

export {
  createPostgresAdapter,
  createPostgresPlugin,
  postgresConfigSchema,
  type PostgresAdapterOptions,
  type PostgresClientLike,
  type PostgresDriverFactory,
  type PostgresPluginOptions,
  type PostgresSslMode,
} from './postgres.js';

export {
  createUnitOfWork,
  defineRepository,
  type CreateUnitOfWorkOptions,
  type RepositoryFactory,
  type TransactionContext,
  type TransactionHook,
  type UnitOfWork,
  type UnitOfWorkRunOptions,
} from './unit-of-work.js';
