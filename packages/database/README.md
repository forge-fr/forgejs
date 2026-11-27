# @forge-fr/database

Database lifecycle plugin, health checks, normalized error taxonomy, transaction propagation, migration hook coordinator, and native PostgreSQL (`postgres-js`) adapter for **ForgeJS**.

## Design Principles (ADR-0005)

- **Standardize operations, never hide native driver/ORM power:** exposes the full native `postgres` (`postgres-js`) tagged-template client via `adapter.client` and DI tokens.
- **Production-safe error normalization:** maps PostgreSQL SQLSTATE codes (`23505`, `23503`, `23502`, `23514`, `40001`, `40P01`, `57014`, Class `08`, network errors) into typed `DatabaseError` subclasses (`expose: false`) without leaking SQL, schema details, or credentials.
- **Credential redaction:** supports `@forge-fr/core` `SecretValue<string>` connection URLs and masks passwords in diagnostic logs and errors (`redactDatabaseUrl()`).
- **First-class ForgeJS plugin:** integrates with `ApplicationKernel` lifecycle (`initialize` connect, `onShutdown` graceful drain) and registers a readiness check in `kernel.health`.

## Integration Testing

Live PostgreSQL integration tests execute automatically when `FORGE_TEST_DATABASE_URL` is set (such as in GitHub Actions PostgreSQL 16 service CI). When unset, live DB tests are explicitly marked skipped rather than falsely passing.

## License

MIT
