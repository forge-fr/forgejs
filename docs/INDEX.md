# ForgeJS Documentation (@forge-fr/*)

- [Documentation Overview](./README.md)
- [Step-by-Step Modular Backend Tutorial (9 Steps)](./tutorials/playground-backend.md)
- [Playground Backend API Example (Node.js & Edge)](../examples/playground/README.md)
- [Modular Backend Example](../examples/modular-backend/README.md)
- [Reproducible Benchmarks (Node.js & Bun)](../benchmarks/RESULTS.md)
- [Contributing Guide](../CONTRIBUTING.md)
- [GitHub Packages Publishing Guide](./id/github-packages-publishing.md)

## Documentation Guides

### Part A: Getting Started

- [Introduction](./guides/getting-started/introduction.md) — What ForgeJS is, how it stays simple and portable across runtimes, and how it compares with Express, Fastify, Hono, and NestJS.
- [Installation](./guides/getting-started/installation.md) — System requirements, public npm and GitHub Packages setup, install commands for pnpm, npm, and Bun, TypeScript config, and quick fixes.
- [Quick Start](./guides/getting-started/quick-start.md) — Create a validated HTTP API with createHttpApp() and validatedHandler(), then run the same code on Node.js, Bun, or Edge.
- [Your First Application](./guides/getting-started/first-application.md) — Step-by-step backend app combining createKernel(), defineModule(), validatedHandler(), security headers, and clean shutdown.

### Part B: Core Concepts

- [Architecture](./guides/concepts/architecture.md) — How ForgeJS organizes code into 6 clear layers enforced by 60 automated boundary checks across all 20 packages.
- [Application Lifecycle](./guides/concepts/lifecycle.md) — Predictable 7-stage startup and shutdown lifecycle in ApplicationKernel with automatic rollback on boot errors.
- [Configuration & Secrets](./guides/concepts/configuration.md) — Manage typed app settings with createConfigManager() and keep passwords or API keys hidden from logs using secret().
- [Dependency Injection](./guides/concepts/dependency-injection.md) — Wire services cleanly with typed tokens, singleton/transient/request lifetimes, cycle detection, and automatic cleanup.
- [Encapsulated Modules](./guides/concepts/modules.md) — Organize features with defineModule(), keep internal helpers private by default, and share only explicit exports.
- [Error Handling](./guides/concepts/error-handling.md) — Use built-in ForgeError classes for clear HTTP errors while automatically hiding internal details and stack traces in production.

### Part C: HTTP & API Development

- [Routing](./guides/http/routing.md) — Fast static route lookup, path parameters with regex constraints, wildcards, nested route groups, and automatic 405 responses.
- [Controllers & Handlers](./guides/http/controllers.md) — Organize HTTP endpoints with plain route-registration functions that pull typed services from ctx.container.
- [Request & Response](./guides/http/request-and-response.md) — Safe size-limited body readers (1 MiB default), clean response helpers, built-in gzip/deflate compression, and ETag caching.
- [Middleware & Hooks](./guides/http/middleware.md) — Predictable middleware ordering (global → module → group → route), double-next protection, and 7 HTTP lifecycle hooks.
- [Validation](./guides/http/validation.md) — Validate params, query, headers, and JSON bodies with Zod v4, Valibot v1, or any Standard Schema v1 library.
- [Response Validation & Serialization](./guides/http/serialization.md) — Check outgoing response data with validatedHandler({ response }) so sensitive fields never slip into API output.
- [OpenAPI 3.1 & Swagger UI](./guides/http/openapi.md) — Generate OpenAPI 3.1 specs straight from your route schemas and serve a hardened Swagger UI page automatically.

### Part D: Database & Data Access

- [Database Overview](./guides/database/overview.md) — How ForgeJS handles PostgreSQL, Drizzle, and Prisma connections, clean error mapping, and password masking in database URLs.
- [PostgreSQL](./guides/database/postgresql.md) — Connect to PostgreSQL with connection pooling, safe transactions, typed SQL error handling, and checksum-checked migrations.
- [Drizzle ORM](./guides/database/drizzle.md) — Use Drizzle ORM with full native TypeScript schema inference via createDrizzlePostgresPlugin() and automatic pool cleanup.
- [Prisma ORM](./guides/database/prisma.md) — Connect PrismaClient (v5, v6, or v7+) to the ForgeJS kernel with clean error mapping and automatic $disconnect on shutdown.
- [Repository Pattern](./guides/database/repository-pattern.md) — Keep business logic independent from your ORM by defining repository tokens that can be swapped cleanly in tests.
- [Database Testing](./guides/database/testing.md) — Run real PostgreSQL 16 integration tests in CI or local Docker by setting FORGE_TEST_DATABASE_URL.

### Part E: Authentication & Security

- [Authentication](./guides/security/authentication.md) — Strong Argon2id password hashing, strict JWT verification, hashed sessions and API keys, OAuth 2.0 PKCE, and Better Auth.
- [Authorization](./guides/security/authorization.md) — Enforce roles (RBAC), custom rules (ABAC), record ownership checks (anti-IDOR), and multi-tenant isolation in one place.
- [Security Guide (OWASP ASVS 5.0.0)](./guides/security/security-guide.md) — Clear breakdown of built-in HTTP protections, optional @forge-fr/security middleware, and what your team still owns.

### Part F: Plugins & Extensions

- [Plugin System](./guides/plugins/plugin-system.md) — How ForgeJS plugins check version compatibility, boot in dependency order, detect conflicts, and run with scoped permissions.
- [Creating Plugins](./guides/plugins/creating-plugins.md) — Write, validate, and test your own ForgeJS plugins using definePlugin(), config schemas, and createPluginTestHarness().
- [Adapter Development](./guides/plugins/adapter-development.md) — Build custom runtime, database, cache, queue, or storage adapters and test them with the shared ForgeJS contract suites.
- [Integrating External Libraries](./guides/plugins/external-libraries.md) — How ForgeJS integrates Redis, Prisma, Zod, and Argon2 via optional peer dependencies without locking your versions.

### Part G: Advanced Features

- [Caching & Redis](./guides/advanced/caching.md) — Fast in-memory LRU cache, safe SCAN-based Redis caching, duplicate-request protection via getOrSet(), and tag invalidation.
- [Queues & Background Jobs](./guides/advanced/queues.md) — Run background jobs with Memory, Redis, or PostgreSQL drivers, automatic retries, dead-letter replay, and clean worker shutdown.
- [Events & Hooks](./guides/advanced/events-and-hooks.md) — Emit typed domain events with flexible error handling and run ordered hook pipelines using @forge-fr/core.
- [File Storage & S3](./guides/advanced/storage.md) — Store files in memory, on local disk, or on S3 (without the AWS SDK) with path-traversal protection and file signature checks.
- [WebSockets & Server-Sent Events](./guides/advanced/realtime.md) — Add real-time WebSockets (app.ws()) with pre-upgrade authentication and Origin checks, plus Server-Sent Events streaming.
- [Logging, Metrics, Tracing & Health Checks](./guides/advanced/observability.md) — Structured JSON logging with automatic secret masking, correlation IDs, OpenTelemetry tracing, and /health/live & /health/ready endpoints.

### Part H: Testing & Production

- [Testing](./guides/deployment/testing.md) — Test HTTP routes, WebSockets, DI overrides, and plugins fast in memory with identical behavior on Node.js and Bun.
- [Runtime Compatibility](./guides/deployment/runtime-compatibility.md) — Honest runtime matrix separating what is tested locally (Node.js v22.23.5, Bun 1.4.4) from CI-configured targets.
- [Production Deployment](./guides/deployment/production.md) — Production checklist covering NODE_ENV=production, graceful shutdown on SIGTERM, health checks, and reverse proxies.
- [Performance & Benchmarks](./guides/deployment/performance.md) — How ForgeJS stays fast and the exact reproducible Node.js v22.23.5 and Bun 1.4.4 benchmark numbers from benchmarks/RESULTS.md.

### Part I: CLI Reference

- [CLI Reference (@forge-fr/cli)](./guides/cli/reference.md) — Complete guide to all 10 forge CLI commands, flags, starter templates, expected output, and error codes.

### Part K: Community & Contributing

- [Contributing](./guides/community/contributing.md) — How the monorepo is organized, coding and boundary rules, and how to run the full test and doc checks before a PR.
- [Plugin Author Guide](./guides/community/plugin-author-guide.md) — Checklist for publishing clean, ESM-only ForgeJS plugins with safe permissions, peer dependencies, and verified tarballs.
- [Release & Versioning](./guides/community/release-and-versioning.md) — Semantic Versioning across all 21 @forge-fr/* packages, what shipped in v1.0.0 General Availability, and how public npm and GitHub Packages releases run.
- [Frequently Asked Questions](./guides/community/faq.md) — Straight answers on runtime support, database ORMs, typed tokens vs. decorators, security boundaries, and benchmarks.

