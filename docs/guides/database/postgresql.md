# PostgreSQL

> Connect to PostgreSQL with connection pooling, safe transactions, typed SQL error handling, and checksum-checked migrations.

- **Section**: Database & Data Access
- **Packages**: @forge-fr/database
- **Version**: v1.0.0
- **Updated**: 2026-11-27
- **HTML URL**: https://github.com/forge-fr/forgejs/docs/database/postgresql
- **Markdown URL**: https://github.com/forge-fr/forgejs/docs/database/postgresql.md
- **Source**: https://github.com/forge-fr/forgejs/blob/main/docs/data-and-auth.md

## Register the PostgreSQL plugin & run transactions

Add createPostgresPlugin() and its config to createKernel({ plugins }). It automatically registers a readiness health check and closes the connection pool cleanly when the app stops.

**File: `src/db/postgres.ts`**

```ts
import { createKernel, secret } from '@forge-fr/core';
import {
  createPostgresPlugin,
  DefaultDatabaseTokens,
  runInTransaction,
} from '@forge-fr/database';

const kernel = createKernel({
  plugins: [
    [
      createPostgresPlugin(),
      {
        url: secret(process.env.DATABASE_URL ?? ''),
        max: 20,
      },
    ],
  ],
});

await kernel.start();
const adapter = kernel.container.resolve(DefaultDatabaseTokens.adapter);

await runInTransaction(
  adapter,
  async (tx) => {
    await tx`INSERT INTO audit_events (event_type) VALUES (${'boot'})`;
  },
  { isolationLevel: 'read committed' },
);
```

## Checksum-verified SQL migrations

createMigrationRunner() stores a SHA-256 checksum for every applied migration and stops if an older migration file was edited unexpectedly.

| Supported Isolation Levels | Mapped PostgreSQL Errors |
| --- | --- |
| read uncommitted · read committed | 23505 → DatabaseUniqueViolationError (duplicate key) |
| repeatable read · serializable | 23503 → DatabaseForeignKeyError · 40001/40P01 → DatabaseSerializationError |
