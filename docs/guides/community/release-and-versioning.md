# Release & Versioning

> Semantic Versioning across all 21 @forge-fr/* packages, what shipped in v1.0.0 General Availability, and how public npm and GitHub Packages releases run.

- **Section**: Community & Contributing
- **Packages**: @forge-fr/core, @forge-fr/config, @forge-fr/http, @forge-fr/database, @forge-fr/openapi, @forge-fr/queue, @forge-fr/cli
- **Version**: v1.0.0
- **Updated**: 2026-11-27
- **HTML URL**: https://github.com/forge-fr/forgejs/docs/community/release-and-versioning
- **Markdown URL**: https://github.com/forge-fr/forgejs/docs/community/release-and-versioning.md
- **Source**: https://github.com/forge-fr/forgejs/blob/main/CHANGELOG.md

## What shipped in v1.0.0 General Availability (2026-11-27)

v1.0.0 completes all 7 production-readiness milestones across all 21 @forge-fr/* packages, adding typed configuration, context state keys, streaming multipart uploads, Unit of Work transactions, auto-discovered OpenAPI 3.1, a modular CRUD CLI generator, Edge-native auth & real-time pub-sub, and distributed job scheduling with transactional outbox delivery.

- @forge-fr/config & Typed Context State: Added @forge-fr/config (defineConfig, loadConfig, createConfigPlugin) with Standard Schema v1 validation and secret redaction, plus symbol-backed ContextKey<T> (ctx.set/get/has/require) across HTTP and WebSocket connections.
- @forge-fr/http & @forge-fr/security: Added streaming ctx.body.multipartStream(), magic-byte MIME verification, RFC 6266 ctx.download(), unified createSecurityMiddleware composer, and sliding-window + Redis/Postgres RateLimitStore adapters.
- @forge-fr/database, @forge-fr/drizzle & @forge-fr/prisma: Added UnitOfWork (uow.run()), TransactionContext (.afterCommit() / .afterRollback()), defineRepository(), createDrizzleUnitOfWork(), and createPrismaUnitOfWork().
- @forge-fr/validation & @forge-fr/openapi: Added automatic OpenAPI 3.1 schema discovery directly from validatedHandler(), complete Zod v3/v4 & Valibot reflection, multipart/binary media types, and guarded Swagger UI in production.
- @forge-fr/cli: Added modular code generation (forge generate resource|module|schema|repository|service|controller) with singular/plural inflection, --dry-run, and collision protection.
- @forge-fr/auth & @forge-fr/http/realtime: Lazy-loaded native @node-rs/argon2 and postgres drivers for zero-alias Edge bundling, added createWebCryptoPasswordHasher (PBKDF2-HMAC-SHA256), and added RealtimeHub room/topic pub-sub with SSE Last-Event-ID replay.
- @forge-fr/queue: Added createJobScheduler (5/6-field cron + IANA timezones + distributed Redis/Postgres lease locks), createTransactionalOutbox (atomic DB outbox + SKIP LOCKED relay), and createDurableEventBridge (EventDispatcher -> Queue with DLQ replay).

## Automated publishing in dependency order to npm and GitHub Packages

GitHub Actions workflows (.github/workflows/release.yml and github-packages.yml) validate, test, audit, and publish all 21 @forge-fr/* packages in strict topological dependency order (core → config → router → http → ... → cli) to the public npm registry (https://registry.npmjs.org) with npm OIDC provenance and to GitHub Packages.

| Release Detail | Current Value |
| --- | --- |
| Current Release | 1.0.0 General Availability (all 21 @forge-fr/* packages) |
| License | MIT |
| Public Repository | https://github.com/forge-fr/forgejs |
| Registries | https://registry.npmjs.org (primary) & https://npm.pkg.github.com (mirror) |
| Verification | 21/21 tarballs checked on Node 22, Bun 1.4, and bundled Cloudflare Worker |
