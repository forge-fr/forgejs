# ForgeJS Documentation (@forge-fr/*)

- [Step-by-Step Modular Backend Tutorial (9 Steps)](./tutorials/playground-backend.md)
- [Modular Backend Example](../examples/modular-backend/README.md)
- [GitHub Packages Publishing Guide](./id/github-packages-publishing.md)

## Documentation Guides

### Part A: Getting Started

- [Introduction](./guides/getting-started/introduction.md) — What ForgeJS is, its architectural philosophy, honest comparisons with Express, Fastify, Hono, and NestJS, and verified runtime targets.
- [Installation](./guides/getting-started/installation.md) — Runtime prerequisites, package manager commands for pnpm, npm, and Bun, CLI scaffolding, TypeScript settings, and troubleshooting.
- [Quick Start](./guides/getting-started/quick-start.md) — Build a schema-validated HTTP API with createHttpApp() and validatedHandler(), then swap seamlessly across Node.js, Bun, and WinterCG Edge.
- [Your First Application](./guides/getting-started/first-application.md) — Step-by-step typed backend combining createKernel(), defineModule(), validatedHandler(), security headers, and graceful shutdown.

### Part B: Core Concepts

- [Architecture](./guides/concepts/architecture.md) — Unidirectional 6-layer architecture enforced by 60 automated boundary checks across all 20 @forgejs/* workspace packages.
- [Application Lifecycle](./guides/concepts/lifecycle.md) — Deterministic 7-stage ApplicationKernel lifecycle with boot-failure rollback, lifecycle events, and reverse-order graceful shutdown.
- [Configuration & Secrets](./guides/concepts/configuration.md) — Typed configuration management via createConfigManager(), prototype-safe key guards, and credential masking with secret() and SecretValue.
- [Dependency Injection](./guides/concepts/dependency-injection.md) — Typed DI tokens, singleton/transient/request scopes, captive-dependency detection, cycle errors, and LIFO async disposal.
- [Encapsulated Modules](./guides/concepts/modules.md) — Define modular boundaries with defineModule(), explicit exports, non-transitive encapsulation, and diamond deduplication.
- [Error Handling](./guides/concepts/error-handling.md) — Structured ForgeError hierarchy, production expose: false sanitization, normalizeError(), and HTTP onError hooks.

### Part C: HTTP & API Development

- [Routing](./guides/http/routing.md) — O(1) static route lookup, constrained radix parameters, wildcards, nested groups, autoHead, and RFC 405 Allow generation.
- [Controllers & Handlers](./guides/http/controllers.md) — Composition-first route registration factories resolving typed DI services via ctx.container and generated via forge generate controller.
- [Request & Response](./guides/http/request-and-response.md) — Compact 13-field ForgeContext, bounded body readers (1 MiB default), RFC 9110 Accept negotiation, streaming, compression, and ETags.
- [Middleware & Hooks](./guides/http/middleware.md) — Deterministic tiered middleware (global → module → group → route), double-next() guards, and 7 HTTP lifecycle hooks.
- [Validation](./guides/http/validation.md) — Standard Schema v1 validation across params, query, headers, and body with Zod v4 fast path and prototype-pollution sanitization.
- [Response Validation & Serialization](./guides/http/serialization.md) — Enforce outgoing response contracts with validatedHandler({ response }) to strip accidental PII before serialization.
- [OpenAPI 3.1 & Swagger UI](./guides/http/openapi.md) — Reflect Standard Schema routes into JSON Schema 2020-12 OpenAPI 3.1 documents and mount XSS-escaped Swagger UI with strict CSP.

### Part D: Database & Data Access

- [Database Overview](./guides/database/overview.md) — DatabaseAdapter contract, SQLSTATE normalization, credential-redacted URLs, and supported PostgreSQL, Drizzle, and Prisma integrations.
- [PostgreSQL](./guides/database/postgresql.md) — Native postgres-js pooling, allowlisted transaction isolation levels, SQLSTATE error mapping, and checksum-verified migrations.
- [Drizzle ORM](./guides/database/drizzle.md) — Preserve 100% native Drizzle schema and relational query inference with createDrizzlePostgresPlugin() and normalizeDrizzleError().
- [Prisma ORM](./guides/database/prisma.md) — Integrate generated PrismaClient (v5/v6/v7+) with P1xxx/P2xxx error normalization and kernel $disconnect draining.
- [Repository Pattern](./guides/database/repository-pattern.md) — Decouple domain services from ORM specifics using typed DI repository tokens and explicit transaction propagation.
- [Database Testing](./guides/database/testing.md) — Run deterministic PostgreSQL 16 integration suites via FORGE_TEST_DATABASE_URL in CI and local Docker environments.

### Part E: Authentication & Security

- [Authentication](./guides/security/authentication.md) — Cross-runtime OWASP Argon2id hashing, algorithm-pinned JWT/JWKS, SHA-256 hashed sessions and API keys, OAuth 2.0 PKCE/OIDC, and Better Auth.
- [Authorization](./guides/security/authorization.md) — Segment-strict RBAC, deny-overrides-allow ABAC policies, anti-IDOR assertOwnership(), and multi-tenant isolation checks.
- [Security Guide (OWASP ASVS 5.0.0)](./guides/security/security-guide.md) — Clear separation of built-in HTTP defaults, optional @forgejs/security middleware, and application/infrastructure security responsibilities.

### Part F: Plugins & Extensions

- [Plugin System](./guides/plugins/plugin-system.md) — SemVer 2.0.0 compatibility engine, topological dependency DAG, conflict detection, and frozen capability-scoped PluginContext.
- [Creating Plugins](./guides/plugins/creating-plugins.md) — Author, validate, and test custom ForgeJS plugins with definePlugin(), Standard Schema config validation, and createPluginTestHarness().
- [Adapter Development](./guides/plugins/adapter-development.md) — Implement custom HTTP runtime, database, cache, queue, or storage adapters and verify them against ForgeJS contract suites.
- [Integrating External Libraries](./guides/plugins/external-libraries.md) — Use optional peerDependencies and duck-typed interfaces (RedisClientLike, PrismaClientLike) to keep core packages dependency-free.

### Part G: Advanced Features

- [Caching & Redis](./guides/advanced/caching.md) — O(1) LRU memory cache, cursor SCAN-based Redis cache, single-flight getOrSet() stampede protection, and tag/prefix invalidation.
- [Queues & Background Jobs](./guides/advanced/queues.md) — Memory, Redis sorted-set (atomic Lua pop), and PostgreSQL SKIP LOCKED job queues with retries, idempotency keys, DLQ replay, and graceful worker drain.
- [Events & Hooks](./guides/advanced/events-and-hooks.md) — Typed EventDispatcher (fail-fast, collect, isolate error strategies) and priority HookRegistry pipelines in @forgejs/core.
- [File Storage & S3](./guides/advanced/storage.md) — Memory, symlink-jailed local disk, and zero-SDK Web Crypto AWS SigV4 S3 object storage with magic-byte upload validation.
- [WebSockets & Server-Sent Events](./guides/advanced/realtime.md) — Cross-runtime app.ws() (RFC 6455 Node, native Bun.serve, Edge) with pre-upgrade auth, CSWSH allowedOrigins, and createSseResponse() streaming.
- [Logging, Metrics, Tracing & Health Checks](./guides/advanced/observability.md) — Structured Pino logging with secret & URL redaction, CRLF neutralization, correlation IDs, OpenTelemetry tracing/metrics, and sanitized /health/live & /health/ready endpoints.

### Part H: Testing & Production

- [Testing](./guides/deployment/testing.md) — In-memory HTTP/WebSocket tests, DI provider overrides, plugin harnesses, and dual-runtime Node.js + Bun verification.
- [Runtime Compatibility](./guides/deployment/runtime-compatibility.md) — Transparent compatibility matrix separating locally verified runtimes (Node.js v22.23.5, Bun 1.4.4) from CI-configured targets.
- [Production Deployment](./guides/deployment/production.md) — Strict ESM builds, NODE_ENV=production hardening, POSIX graceful draining, health probes, and reverse-proxy configuration.
- [Performance & Benchmarks](./guides/deployment/performance.md) — Hot-path HTTP optimizations and verbatim reproducible Node.js v22.23.5 & Bun 1.4.4 benchmark results from benchmarks/RESULTS.md.

### Part I: CLI Reference

- [CLI Reference (@forgejs/cli)](./guides/cli/reference.md) — Complete reference for all 10 verified forge CLI commands, flags, templates, expected output, and error codes from packages/cli/src/commands.ts.

### Part K: Community & Contributing

- [Contributing](./guides/community/contributing.md) — Monorepo workspace layout, strict TypeScript standards, architectural boundary tests, and verification commands for contributors.
- [Plugin Author Guide](./guides/community/plugin-author-guide.md) — Checklist for publishing pure-ESM, capability-scoped third-party ForgeJS plugins with SemVer safety and clean npm pack tarballs.
- [Release & Versioning](./guides/community/release-and-versioning.md) — SemVer 2.0.0 versioning across all 20 @forgejs/* packages, v1.0.0-rc.1 status, and OIDC Trusted Publishing workflow.
- [Frequently Asked Questions](./guides/community/faq.md) — Direct answers on runtime compatibility, ORM choices, decorators vs. typed tokens, security boundaries, and benchmark reproduction.

