# Database Testing

> Run deterministic PostgreSQL 16 integration suites via FORGE_TEST_DATABASE_URL in CI and local Docker environments.

- **Section**: Database & Data Access
- **Packages**: @forge-fr/database, @forge-fr/testing
- **Version**: v1.0.0-rc.1
- **Updated**: 2026-11-26
- **HTML URL**: https://github.com/forge-fr/forgejs/docs/database/testing
- **Markdown URL**: https://github.com/forge-fr/forgejs/docs/database/testing.md
- **Source**: https://github.com/forge-fr/forgejs/blob/main/docs/data-and-auth.md

## Real PostgreSQL 16 CI integration tests

ForgeJS ships 4 live PostgreSQL integration suites (postgres, drizzle, prisma, and PostgreSQL SKIP LOCKED queue) wired to the postgres:16-alpine service container in .github/workflows/ci.yml. When FORGE_TEST_DATABASE_URL is unset locally, suites explicitly report SKIPPED rather than falsely passing.

**File: `terminal`**

```bash
# Run live PostgreSQL 16 integration tests against local Docker
docker run --rm -e POSTGRES_PASSWORD=forge -e POSTGRES_DB=forge_test -p 5432:5432 postgres:16-alpine
FORGE_TEST_DATABASE_URL=postgres://postgres:forge@127.0.0.1:5432/forge_test npx vitest run
```
