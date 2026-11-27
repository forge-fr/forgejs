# @forge-fr/drizzle

Official Drizzle ORM adapter and ForgeJS plugin preserving native Drizzle query builders, schema inference, connection pooling, health checks, and SQLSTATE error normalization across Node.js and Bun.

## Features

- Full native `PostgresJsDatabase<TSchema>` client exported directly via typed DI tokens (`createDrizzleToken`).
- Automatic `connect()` on kernel `initialize`, `SELECT 1` health checks in `kernel.health`, and graceful pool drain on `onShutdown`.
- `normalizeDrizzleError()` unwrapping Drizzle `DrizzleQueryError` causes into ForgeJS `DatabaseError` subclasses (`expose: false`).
- Standardized transaction execution with allowlisted PostgreSQL isolation levels.
- Generic `createDrizzleAdapter()` factory for non-PostgreSQL Drizzle dialects.
