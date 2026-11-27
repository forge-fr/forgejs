# PostgreSQL

> Native postgres-js pooling, allowlisted transaction isolation levels, SQLSTATE error mapping, and checksum-verified migrations.

- **Section**: Database & Data Access
- **Packages**: @forge-fr/database
- **Version**: v1.0.0-rc.1
- **Updated**: 2026-11-26
- **HTML URL**: https://github.com/forge-fr/forgejs/docs/database/postgresql
- **Markdown URL**: https://github.com/forge-fr/forgejs/docs/database/postgresql.md
- **Source**: https://github.com/forge-fr/forgejs/blob/main/docs/data-and-auth.md

## Registering the PostgreSQL plugin & running transactions

Pass createPostgresPlugin() and its runtime config tuple into createKernel({ plugins }) or call kernel.plugin(createPostgresPlugin(), config). The plugin automatically registers a health probe and closes the pool cleanly on kernel.shutdown().

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

createMigrationRunner() tracks applied migrations with SHA-256 checksums, rejecting tampered historical migrations before executing new SQL files.

| Isolation Level (Allowlisted) | SQLSTATE Mapped Errors |
| --- | --- |
| read uncommitted · read committed | 23505 → DatabaseUniqueViolationError (409 internal) |
| repeatable read · serializable | 23503 → DatabaseForeignKeyError · 40001/40P01 → DatabaseSerializationError |
