# ForgeJS Documentation

Every `ts forge-example` code snippet in this documentation (**22 snippets across 10 files**) is type-checked (`tsc --noEmit`) and executed on both **Node.js (`v22.23.5`)** and **Bun (`1.4.4`)** (`44 / 44` verified runs) via `scripts/verify-docs-examples.mjs`.

- **Website & Interactive Playground:** [https://forgejs.id](https://forgejs.id)
- **Public Repository (`@forge-fr/*`):** [https://github.com/forge-fr/forgejs](https://github.com/forge-fr/forgejs)

## English Documentation (Primary)

1. [Quick Start](./quick-start.md) — Start with a simple HTTP API or a modular DI app, and test routes in memory with `createTestClient`, `createTestKernel`, and `createTestApp`.
2. [Architecture, DI, Modules & Plugins](./architecture.md) — Learn how `ApplicationKernel`, typed tokens, `@forge-fr/config`, private modules (`defineModule()`), and permission-checked plugins (`definePlugin()`) work together.
3. [HTTP Engine, Validation, OpenAPI 3.1 & WebSockets](./http-and-validation.md) — Fast routing, `ContextKey<T>` typed state, streaming multipart uploads, Zod/Valibot validation, auto-discovered OpenAPI 3.1 & Swagger UI, and `@forge-fr/http/realtime` (`RealtimeHub`).
4. [Database, ORM, Authentication & Authorization](./data-and-auth.md) — PostgreSQL, Drizzle, and Prisma with `UnitOfWork` (`.afterCommit()` / `.afterRollback()`), Argon2id & Edge Web Crypto password hashing, JWTs, sessions, RBAC/ABAC, ownership checks, and tenant isolation.
5. [Security & Observability](./security-and-observability.md) — `createSecurityMiddleware` composer, headers, CORS, CSRF, sliding-window & Redis/Postgres rate limiting, SSRF guards, dot-path redacted Pino & `@forge-fr/logger/edge` logging, OpenTelemetry, and health probes.
6. [Infrastructure Plugins, CLI & Edge Runtimes](./infrastructure-and-cli.md) — Caching (`@forge-fr/cache`), background job queues & cron scheduler / transactional outbox / durable event bridge (`@forge-fr/queue`), file storage (`@forge-fr/storage`), modular CRUD code generator (`@forge-fr/cli`), and `@forge-fr/edge` (Cloudflare Workers / Deno).

## Dokumentasi Bahasa Indonesia

1. [Panduan Memulai Cepat (Quick Start)](./id/quick-start.md)
2. [Arsitektur Inti, Optimasi Hot-Path, DI & Sistem Plugin](./id/architecture.md)
3. [Panduan Keamanan & OWASP ASVS 5.0.0](./id/security.md)

## Release & Verification Summary (`v1.0.0`)

- **What's New in `v1.0.0` (General Availability):** All 21 `@forge-fr/*` packages synchronized for public npm (`registry.npmjs.org`) and GitHub Packages (`npm.pkg.github.com`), including `@forge-fr/config`, symbol-backed `ContextKey<T>`, `@forge-fr/logger/edge` & dot-path redaction, `createTestKernel`/`createTestApp`, streaming multipart uploads & `createSecurityMiddleware` + Redis/Postgres `RateLimitStore`, `UnitOfWork` across PostgreSQL/Drizzle/Prisma, auto-discovered OpenAPI 3.1 from `validatedHandler()`, modular `forge generate resource|module|...` CLI code generator, Edge-native `createWebCryptoPasswordHasher` & `@forge-fr/http/realtime` `RealtimeHub`, and `@forge-fr/queue` `createJobScheduler` / `createTransactionalOutbox` / `createDurableEventBridge`. See [`CHANGELOG.md`](../CHANGELOG.md) for details.
- **Node.js `v22.23.5` Benchmarks:** `#1` in-process Static JSON (`317,446 ops/sec`, `2.42x` Hono, `20.9x` Fastify), `#1` in-process 5-Middleware Chain (`254,577 ops/sec`), `#1` in-process Zod Validated POST (`53,646 ops/sec`), `#1` Cold Startup (`61.01 ms`), and `#1` live HTTP throughput on Static JSON (`3,867.36 req/s`), Param + Query (`3,877.08 req/s`), and 5-Middleware Chain (`3,977.83 req/s`), with `3,336.7 req/s` on Zod Validated POST.
- **Bun `1.4.4` Benchmarks:** `#1` in-process Static JSON (`721,724 ops/sec`), `#1` in-process 5-Middleware Chain (`446,581 ops/sec`), `#1` in-process Zod Validated POST (`244,320 ops/sec`), `11.08 ms` cold startup, and ahead of Fastify across all 4 live HTTP scenarios (`7,275.57 req/s` static JSON, `7,862.83 req/s` param+query, `8,216.07 req/s` 5-middleware, `6,454.94 req/s` Zod POST).
- [Full Reproducible Benchmark Results (Node 22 & Bun 1.4)](../benchmarks/RESULTS.md)
- [Verification Matrix & Test Results (`260 passed` baseline / `334+ passed` full Vitest suite, Node 22 + Bun 1.4 smoke suites, `22/22` doc snippets / `44/44` runs)](../TEST_RESULTS.md)
