# Database Testing

> Run real PostgreSQL 16 integration tests in CI or local Docker by setting FORGE_TEST_DATABASE_URL.

- **Section**: Database & Data Access
- **Packages**: @forge-fr/database, @forge-fr/testing
- **Version**: v1.0.0
- **Updated**: 2026-11-27
- **HTML URL**: https://github.com/forge-fr/forgejs/docs/database/testing
- **Markdown URL**: https://github.com/forge-fr/forgejs/docs/database/testing.md
- **Source**: https://github.com/forge-fr/forgejs/blob/main/docs/data-and-auth.md

## Real PostgreSQL 16 integration suites

ForgeJS includes 4 real PostgreSQL integration suites (postgres, drizzle, prisma, and PostgreSQL job queue) connected to postgres:16-alpine in CI. If FORGE_TEST_DATABASE_URL is not set locally, those suites clearly report SKIPPED instead of pretending to pass.

**File: `terminal`**

```bash
# Start a local PostgreSQL 16 container and run live database tests
docker run --rm -e POSTGRES_PASSWORD=forge -e POSTGRES_DB=forge_test -p 5432:5432 postgres:16-alpine
FORGE_TEST_DATABASE_URL=postgres://postgres:forge@127.0.0.1:5432/forge_test npx vitest run
```
