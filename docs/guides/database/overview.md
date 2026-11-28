# Database Overview

> How ForgeJS handles PostgreSQL, Drizzle, and Prisma connections, clean error mapping, and password masking in database URLs.

- **Section**: Database & Data Access
- **Packages**: @forge-fr/database, @forge-fr/drizzle, @forge-fr/prisma
- **Version**: v1.0.0
- **Updated**: 2026-11-27
- **HTML URL**: https://github.com/forge-fr/forgejs/docs/database/overview
- **Markdown URL**: https://github.com/forge-fr/forgejs/docs/database/overview.md
- **Source**: https://github.com/forge-fr/forgejs/blob/main/docs/data-and-auth.md

## Official database integrations

- @forge-fr/database — Direct PostgreSQL support (powered by postgres-js) with connection pooling, transactions, migrations, and typed errors.
- @forge-fr/drizzle — Drizzle ORM plugin that keeps 100% of Drizzle native TypeScript query inference.
- @forge-fr/prisma — Prisma ORM plugin supporting Prisma v5, v6, and v7+ generated clients with clean error mapping.

> **NOTE: Using another ORM or database?**
>
> TypeORM, MikroORM, Sequelize, and Knex do not have official ForgeJS plugins. You can still plug in any database or ORM cleanly using the DatabaseAdapter interface and createDatabasePlugin().

## Safe URL masking & typed database errors

Database adapters hide passwords in connection URLs via redactDatabaseUrl() and turn raw driver errors into typed ForgeError classes (hidden from clients by default so SQL details never leak).

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
