# @forge-fr/database

> PostgreSQL adapter built on postgres-js with UnitOfWork (.afterCommit/.afterRollback), defineRepository, clean error mapping, hidden connection passwords, and SQL migrations.

- **Version**: v1.0.0
- **Layer**: Adapter Layer
- **Category**: database
- **Tarball**: 17.9 kB (28 files)
- **Internal deps**: @forge-fr/core
- **Runtime deps**: postgres ^3.4.0 || ^4.0.0
- **Peer deps**: none
- **HTML URL**: https://github.com/forge-fr/forgejs/api/database
- **Markdown URL**: https://github.com/forge-fr/forgejs/api/database.md

## Installation

```bash
# Add once to .npmrc: @forge-fr:registry=https://npm.pkg.github.com
npm install @forge-fr/database
```

## Plugin Metadata

- **Factory**: `createPostgresPlugin / createDatabasePlugin`
- **Tokens**: `DefaultDatabaseTokens`
- **Health probe**: `database`
- **Capabilities**: `di:register`, `health:register`

## Runtime & Error Semantics

- **Runtime**: Built on postgres (postgres-js). Live PostgreSQL 16 integration tests run in CI when FORGE_TEST_DATABASE_URL is configured.
- **Errors**: Normalizes SQLSTATE codes (23505, 23503, 23502, 23514, 40001) into typed DatabaseError subclasses with expose: false by default.

## Usage Example

```ts
import { createKernel, secret } from '@forge-fr/core';
import { createPostgresPlugin, DefaultDatabaseTokens } from '@forge-fr/database';

const kernel = createKernel({
  plugins: [[createPostgresPlugin(), { url: secret(process.env.DATABASE_URL ?? '') }]],
});
await kernel.start();
const adapter = kernel.container.resolve(DefaultDatabaseTokens.adapter);
```

## Public Exports

### PostgreSQL Adapter, Plugins & Migrations

- **Values**: `createDatabasePlugin`, `createPostgresAdapter`, `createPostgresPlugin`, `postgresConfigSchema`, `DefaultDatabaseTokens`, `createDatabaseToken`, `runInTransaction`, `createMigrationCoordinator`
- **Types**: `DatabaseAdapter`, `DatabaseConnectionState`, `DatabasePingResult`, `DatabasePluginOptions`, `DatabaseTokens`, `Migration`, `MigrationCoordinator`, `MigrationCoordinatorOptions`, `MigrationHooks`, `MigrationRecord`, `MigrationRunResult`, `MigrationStateStore`, `PostgresAdapterOptions`, `PostgresClientLike`, `PostgresDriverFactory`, `PostgresPluginOptions`, `PostgresSslMode`, `TransactionIsolationLevel`, `TransactionOptions`

### Database Errors & URL Redaction

- **Values**: `DatabaseError`, `DatabaseConnectionError`, `DatabaseUniqueViolationError`, `DatabaseForeignKeyViolationError`, `DatabaseNotNullViolationError`, `DatabaseCheckViolationError`, `DatabaseSerializationError`, `DatabaseTimeoutError`, `normalizeDatabaseError`, `redactDatabaseUrl`, `MigrationChecksumError`, `MigrationRollbackError`
- **Types**: `DatabaseErrorOptions`
