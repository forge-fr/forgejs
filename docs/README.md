# ForgeJS Documentation

Every `ts forge-example` code snippet across this documentation (**22 snippets across 10 files**) is extracted, strictly type-checked (`tsc --noEmit` under `NodeNext` + `exactOptionalPropertyTypes`), and executed on both **Node.js (`v22.23.5`)** and **Bun (`1.4.4`)** (`44 / 44` verified runs) by `scripts/verify-docs-examples.mjs`.

## English Documentation (Primary)

1. [Quick Start](./quick-start.md) — Simple HTTP API vs Modular DI API and testing with `createTestClient`.
2. [Architecture, DI, Modules & Plugins](./architecture.md) — `ApplicationKernel`, typed `InjectionToken`, encapsulated `defineModule()`, and capability-scoped `definePlugin()`.
3. [HTTP Engine, Validation, OpenAPI 3.1 & WebSockets](./http-and-validation.md) — O(1) static route lookup + Radix routing, synchronous-first hot path (`FastResponse`/`FastHeaders`, `FastNodeRequest`/`LazyNodeHeaders`), `CompressionStream` & `ETag` caching, Standard Schema validation (`validateOrThrowSyncOrAsync` for Zod v4 & Valibot v1), Swagger UI, and cross-runtime WebSockets.
4. [Database, ORM, Authentication & Authorization](./data-and-auth.md) — Transactions, migrations, Drizzle/Prisma adapters, Argon2id, JWT, sessions, RBAC, anti-IDOR ownership, and multi-tenant isolation.
5. [Security & Observability](./security-and-observability.md) — Security headers, CSP, CORS, CSRF, rate limiting, SSRF fetch guard, Pino log redaction, OpenTelemetry, and health probes.
6. [Infrastructure Plugins, CLI & Edge Runtimes](./infrastructure-and-cli.md) — Cache (`@forge-fr/cache`), Priority Queue & DLQ (`@forge-fr/queue` Memory/Redis/PostgreSQL `SKIP LOCKED`), Object Storage (`@forge-fr/storage`), `@forge-fr/cli`, and `@forge-fr/edge` (Cloudflare Workers / Deno).

## Dokumentasi Bahasa Indonesia

1. [Panduan Memulai Cepat (Quick Start)](./id/quick-start.md)
2. [Arsitektur Inti, Optimasi Hot-Path, DI & Sistem Plugin](./id/architecture.md)
3. [Panduan Keamanan & OWASP ASVS 5.0.0](./id/security.md)

## Release & Verification Summary (`v1.0.0-rc.2`)

- **What's New in `v1.0.0-rc.2`:** Native `Response` materialization on Cloudflare Workers (`workerd`), Deno, and Bun (`@forge-fr/http` `toNativeResponse()` + `@forge-fr/edge` handlers), `MemoryLogSink` support under `pino/browser.js` (`@forge-fr/logger`), Edge-safe inline webhook draining, native Node.js 22 ESM production startup, and Node 24 GitHub Actions workflows. See [`CHANGELOG.md`](../CHANGELOG.md) for full details.
- **Node.js `v22.23.5` Benchmarks:** `#1` in-process Static JSON (`317,446 ops/sec`, `2.42x` Hono, `20.9x` Fastify), `#1` in-process 5-Middleware Chain (`254,577 ops/sec`), `#1` in-process Zod Validated POST (`53,646 ops/sec`), `#1` Cold Startup (`61.01 ms`), and `#1` live HTTP throughput on Static JSON (`3,867.36 req/s`), Param + Query (`3,877.08 req/s`), and 5-Middleware Chain (`3,977.83 req/s`), with `3,336.7 req/s` on Zod Validated POST.
- **Bun `1.4.4` Benchmarks:** `#1` in-process Static JSON (`721,724 ops/sec`), `#1` in-process 5-Middleware Chain (`446,581 ops/sec`), `#1` in-process Zod Validated POST (`244,320 ops/sec`), `11.08 ms` cold startup, and beats Fastify across all 4 live HTTP scenarios (`7,275.57 req/s` static JSON, `7,862.83 req/s` param+query, `8,216.07 req/s` 5-middleware, `6,454.94 req/s` Zod POST).
- [Full Reproducible Benchmark Results (Node 22 & Bun 1.4)](../benchmarks/RESULTS.md)
- [Verification Matrix & Test Results (`260 passed` Vitest, `44/44` Node 22 + Bun 1.4 smoke suites, `22/22` doc snippets / `44/44` runs)](../TEST_RESULTS.md)
