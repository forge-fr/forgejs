# Database Overview

> DatabaseAdapter contract, SQLSTATE normalization, credential-redacted URLs, and supported PostgreSQL, Drizzle, and Prisma integrations.

- **Section**: Database & Data Access
- **Packages**: @forge-fr/database, @forge-fr/drizzle, @forge-fr/prisma
- **Version**: v1.0.0-rc.1
- **Updated**: 2026-11-26
- **HTML URL**: https://github.com/forge-fr/forgejs/docs/database/overview
- **Markdown URL**: https://github.com/forge-fr/forgejs/docs/database/overview.md
- **Source**: https://github.com/forge-fr/forgejs/blob/main/docs/data-and-auth.md

## Verified official integrations

- @forge-fr/database — Native PostgreSQL driver built on postgres (postgres-js) with pooling, transactions, migrations, and SQLSTATE error mapping.
- @forge-fr/drizzle — First-class Drizzle ORM plugin preserving 100% native PostgresJsDatabase<TSchema> inference.
- @forge-fr/prisma — Prisma ORM plugin supporting Prisma v5/v6/v7+ generated clients with P1xxx/P2xxx error normalization.

> **NOTE: Explicit ORM Scope Disclosure**
>
> TypeORM, MikroORM, Sequelize, and Knex do not have official ForgeJS packages. Teams using other ORMs or SQL dialects can integrate them cleanly via the generic DatabaseAdapter contract and createDatabasePlugin().

## Credential redaction & SQLSTATE normalization

All database adapters sanitize connection strings via redactDatabaseUrl() and map raw driver errors into typed ForgeError subclasses with expose: false by default so SQL statements and credentials never leak.

**File: `src/db/errors.ts`**

```ts
import assert from 'node:assert/strict';
import {
  DatabaseUniqueViolationError,
  normalizeDatabaseError,
  redactDatabaseUrl,
} from '@forge-fr/database';

const safeUrl = redactDatabaseUrl('postgres://admin:top_secret@db.internal:5432/prod');
assert.ok(safeUrl.includes('admin:[REDACTED]@db.internal:5432/prod'));

const normalized = normalizeDatabaseError({
  code: '23505',
  message: 'duplicate key value violates unique constraint',
});
assert.ok(normalized instanceof DatabaseUniqueViolationError);
assert.equal(normalized.expose, false);
```
