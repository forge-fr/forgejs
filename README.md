# ForgeJS (`@forge-fr/*` · `v1.0.0-rc.1`)

[![CI](https://github.com/forge-fr/forgejs/actions/workflows/ci.yml/badge.svg)](https://github.com/forge-fr/forgejs/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Runtimes](https://img.shields.io/badge/Runtimes-Node%20%3E%3D22.18%20%7C%20Bun%20%3E%3D1.4%20%7C%20Edge-0f766e.svg)](#runtime-support)
[![Security: OWASP ASVS 5.0.0](https://img.shields.io/badge/Security-OWASP%20ASVS%205.0.0-1d4ed8.svg)](./SECURITY.md)

A pure-ESM, strict-TypeScript backend framework running identically on **Node.js (`>=22.18.0`)**, **Bun (`>=1.4.0`)**, and **WinterCG Edge / Cloudflare Workers** with composition-first dependency injection, Web Standards HTTP pipelines, capability-scoped plugins, and OWASP ASVS 5.0.0 security defaults.

- **Web Portal & Documentation:** [https://forgejs.dev](https://forgejs.dev)
- **Interactive Multi-Tenant Playground:** [https://forgejs.dev/playground](https://forgejs.dev/playground)
- **9-Step Modular Backend Tutorial:** [Build a Production Backend Step by Step](./docs/tutorials/playground-backend.md)
- **Documentation Hub (EN & ID):** [Documentation Index](./docs/INDEX.md)
- **AI / LLM Documentation Corpus:** [`llms.txt`](./llms.txt) · [`llms-full.txt`](./llms-full.txt)

---

## Install `@forge-fr/*` Packages (GitHub Packages)

All 20 `@forge-fr/*` packages are published to **GitHub Packages** (`https://npm.pkg.github.com`).

1. Configure your project or user `.npmrc` (see [`.npmrc.github.example`](./.npmrc.github.example)):

```ini
@forge-fr:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}
```

2. Install the packages you need:

```bash
npm install @forge-fr/core @forge-fr/http @forge-fr/node @forge-fr/validation zod
```

> Read the step-by-step publishing & consumer guide in [`docs/id/github-packages-publishing.md`](./docs/id/github-packages-publishing.md).

---

## Quick Example

```ts forge-example
import assert from 'node:assert/strict';
import { createHttpApp } from '@forge-fr/http';
import { createTestClient } from '@forge-fr/testing';
import { validatedHandler } from '@forge-fr/validation';
import { z } from 'zod';

const app = createHttpApp();

app.get('/health', (ctx) => ctx.json({ ok: true, runtime: 'forgejs' }));

app.post(
  '/users',
  validatedHandler(
    {
      body: z.object({
        email: z.string().email(),
        role: z.enum(['member', 'admin']).default('member'),
      }),
    },
    (ctx, input) => ctx.json({ created: true, user: input.body }, { status: 201 }),
  ),
);

const client = createTestClient(app);
const health = await client.get('/health');
assert.equal(health.status, 200);
assert.deepEqual(await health.json(), { ok: true, runtime: 'forgejs' });

const created = await client.post('/users', {
  json: { email: 'ada@example.com' },
});
assert.equal(created.status, 201);
assert.deepEqual(await created.json(), {
  created: true,
  user: { email: 'ada@example.com', role: 'member' },
});

await client.close();
```

### Runnable Examples

- [Playground Backend API (Node.js & Cloudflare Workers)](./examples/playground/README.md) — Production-style multi-tenant backend powering the live Playground API (`auth`, `security`, `tasks`, `attachments`, `webhooks`, `realtime`, `system`) on `@forge-fr/node` and `@forge-fr/edge`
- [Modular Multi-Tenant Backend](./examples/modular-backend/README.md) — Core multi-tenant backend modules (`src/` layout) on Node.js
- [Quick Start Minimal Server](./examples/quick-start/README.md) — Minimal HTTP routing + Zod schema validation

---

## Packages (`20 / 20` Monorepo Architecture)

| Layer | Packages & API Reference |
| :--- | :--- |
| **Core & Kernel** | [`@forge-fr/core`](./docs/api/core.md) · [`@forge-fr/router`](./docs/api/router.md) · [`@forge-fr/http`](./docs/api/http.md) |
| **Runtime Adapters** | [`@forge-fr/node`](./docs/api/node.md) · [`@forge-fr/bun`](./docs/api/bun.md) · [`@forge-fr/edge`](./docs/api/edge.md) |
| **Validation & Data** | [`@forge-fr/validation`](./docs/api/validation.md) · [`@forge-fr/database`](./docs/api/database.md) · [`@forge-fr/drizzle`](./docs/api/drizzle.md) · [`@forge-fr/prisma`](./docs/api/prisma.md) · [`@forge-fr/openapi`](./docs/api/openapi.md) |
| **Auth & Security** | [`@forge-fr/auth`](./docs/api/auth.md) · [`@forge-fr/authorization`](./docs/api/authorization.md) · [`@forge-fr/security`](./docs/api/security.md) |
| **Observability & Infra** | [`@forge-fr/logger`](./docs/api/logger.md) · [`@forge-fr/cache`](./docs/api/cache.md) · [`@forge-fr/queue`](./docs/api/queue.md) · [`@forge-fr/storage`](./docs/api/storage.md) |
| **Tooling & CLI** | [`@forge-fr/testing`](./docs/api/testing.md) · [`@forge-fr/cli`](./docs/api/cli.md) |

---

## Runtime Support

- **Node.js `>=22.18.0`**: Native `IncomingMessage` / `ServerResponse` bridge + RFC 6455 WebSocket upgrade via `@forge-fr/node`.
- **Bun `>=1.4.0`**: Native `Bun.serve()` HTTP & WebSocket server via `@forge-fr/bun`.
- **WinterCG Edge & Cloudflare Workers**: Standard Fetch API + `WebSocketPair` / `ExecutionContext` support via `@forge-fr/edge`.

---

## Performance Highlights (Reproducible Benchmarks)

Measured with [`benchmarks/run-all.mjs`](./benchmarks/run-all.mjs) on identical 24-route tables against **Hono `4.13.22`** and **Fastify `5.12.8`** (full methodology & raw numbers in [`benchmarks/RESULTS.md`](./benchmarks/RESULTS.md)):

| Benchmark Scenario | Node.js · ForgeJS | Node.js · Hono | Node.js · Fastify | Bun · ForgeJS | Bun · Hono | Bun · Fastify |
| :--- | ---: | ---: | ---: | ---: | ---: | ---: |
| **In-Process Static JSON** | **`317,446 ops/s` (#1)** | `131,194 ops/s` | `15,197 ops/s` | **`721,724 ops/s` (#1)** | `525,907 ops/s` | `44,613 ops/s` |
| **In-Process 5-Middleware Chain** | **`254,577 ops/s` (#1)** | `97,585 ops/s` | `22,392 ops/s` | **`446,581 ops/s` (#1)** | `205,246 ops/s` | `47,400 ops/s` |
| **In-Process Zod Validated POST** | **`53,646 ops/s` (#1)** | `43,419 ops/s` | `11,868 ops/s` | **`244,320 ops/s` (#1)** | `214,530 ops/s` | `30,506 ops/s` |
| **Live HTTP `GET /mw/ping`** | **`3,977.83 req/s` (#1)** | `3,755.81 req/s` | `3,898.31 req/s` | **`8,216.07 req/s` (#1)** | `7,005.50 req/s` | `6,796.26 req/s` |
| **Cold Startup Median** | **`61.01 ms` (#1)** | `61.44 ms` | `163.92 ms` | **`11.08 ms`** | `10.79 ms` | `112.25 ms` |

Reproduce locally:

```bash
npm install
npm run build
npm run bench
```

---

## Documentation (English & Bahasa Indonesia)

- **Portal & Full Corpus Index:** [`docs/INDEX.md`](./docs/INDEX.md) · [`docs/README.md`](./docs/README.md) · [Live Docs Portal](https://forgejs.dev/docs/getting-started/introduction)
- **English Guides:** [Quick Start](./docs/quick-start.md) · [Architecture & Plugins](./docs/architecture.md) · [HTTP, Validation, OpenAPI & WebSockets](./docs/http-and-validation.md) · [Database, Auth & Authorization](./docs/data-and-auth.md) · [Security & Observability](./docs/security-and-observability.md) · [Cache, Queue, Storage, CLI & Edge](./docs/infrastructure-and-cli.md)
- **Hands-On Tutorial:** [Build a Production Modular Backend (9 Steps)](./docs/tutorials/playground-backend.md) · [Interactive Stepper](https://forgejs.dev/docs/tutorials/playground-backend)
- **Panduan Bahasa Indonesia:** [Memulai Cepat](./docs/id/quick-start.md) · [Arsitektur & Plugin](./docs/id/architecture.md) · [Keamanan (OWASP ASVS 5.0.0)](./docs/id/security.md) · [Publikasi GitHub Packages](./docs/id/github-packages-publishing.md)

---

## Community, Support & Security

- **Contributing:** Read [`CONTRIBUTING.md`](./CONTRIBUTING.md) and our [`CODE_OF_CONDUCT.md`](./CODE_OF_CONDUCT.md) before opening a pull request.
- **Bug Reports & Feature Requests:** [Open a GitHub Issue](https://github.com/forge-fr/forgejs/issues/new/choose).
- **Support:** See [`SUPPORT.md`](./SUPPORT.md) for documentation pointers and troubleshooting steps.
- **Security Vulnerabilities:** Read [`SECURITY.md`](./SECURITY.md) and report vulnerabilities privately via [GitHub Private Vulnerability Reporting](https://github.com/forge-fr/forgejs/security/advisories/new) — please **do not** disclose security issues in public issues.
- **Changelog & License:** [`CHANGELOG.md`](./CHANGELOG.md) · [`LICENSE` (MIT)](./LICENSE)
