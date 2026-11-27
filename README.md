# ForgeJS (`@forge-fr/*` · `v1.0.0-rc.1`)

A pure-ESM, strict-TypeScript backend framework running identically on **Node.js (`>=22.18.0`)**, **Bun (`>=1.4.0`)**, and **WinterCG Edge** with composition-first dependency injection, Web Standards HTTP pipelines, capability-scoped plugins, and OWASP ASVS 5.0.0 security defaults.

## Packages (`20 / 20` Monorepo Architecture · `1.0.0-rc.1` Tarball & OIDC Verified)

| Layer | Packages |
| :--- | :--- |
| **Core & Kernel** | `@forge-fr/core`, `@forge-fr/router`, `@forge-fr/http` (Web Streams compression & SHA-256 ETag), `@forge-fr/testing` |
| **Runtime Adapters** | `@forge-fr/node`, `@forge-fr/bun`, `@forge-fr/edge` (WinterCG / Cloudflare Workers / Deno) |
| **Validation & Data** | `@forge-fr/validation`, `@forge-fr/database`, `@forge-fr/drizzle`, `@forge-fr/prisma` |
| **Auth & Security** | `@forge-fr/auth`, `@forge-fr/authorization`, `@forge-fr/security` |
| **Observability & Infra** | `@forge-fr/logger`, `@forge-fr/cache`, `@forge-fr/queue` (Memory / Redis / PostgreSQL `SKIP LOCKED`), `@forge-fr/storage` |
| **API & Tooling** | `@forge-fr/openapi`, `@forge-fr/cli` (`forge` CLI binary) |

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

## Performance Highlights (Node.js `v22.23.5` & Bun `1.4.4`)

Reproducible head-to-head benchmarks (`benchmarks/run-all.mjs`, identical 24-route tables, zero cherry-picking) against **Hono `4.13.22`** and **Fastify `5.12.8`**:

| Benchmark Scenario | Node.js · ForgeJS | Node.js · Hono | Node.js · Fastify | Bun · ForgeJS | Bun · Hono | Bun · Fastify |
| :--- | ---: | ---: | ---: | ---: | ---: | ---: |
| **In-Process Static JSON (`app.fetch` / `inject`)** | **`317,446 ops/s` (#1)** | `131,194 ops/s` | `15,197 ops/s` | **`721,724 ops/s` (#1)** | `525,907 ops/s` | `44,613 ops/s` |
| **In-Process 5-Middleware Chain (`/mw/ping`)** | **`254,577 ops/s` (#1)** | `97,585 ops/s` | `22,392 ops/s` | **`446,581 ops/s` (#1)** | `205,246 ops/s` | `47,400 ops/s` |
| **In-Process Zod Validated POST (`/items`)** | **`53,646 ops/s` (#1)** | `43,419 ops/s` | `11,868 ops/s` | **`244,320 ops/s` (#1)** | `214,530 ops/s` | `30,506 ops/s` |
| **Live HTTP `GET /json` (`c=24` keep-alive)** | **`3,867.36 req/s` (#1)** | `3,724.83 req/s` | `3,864.97 req/s` | `7,275.57 req/s` | `7,570.29 req/s` | `6,538.15 req/s` |
| **Live HTTP `GET /users/:id/posts?limit=15`** | **`3,877.08 req/s` (#1)** | `3,681.48 req/s` | `3,826.90 req/s` | **`7,862.83 req/s` (#1)** | `7,848.43 req/s` | `6,642.78 req/s` |
| **Live HTTP `GET /mw/ping` (5-Middleware)** | **`3,977.83 req/s` (#1)** | `3,755.81 req/s` | `3,898.31 req/s` | **`8,216.07 req/s` (#1)** | `7,005.50 req/s` | `6,796.26 req/s` |
| **Live HTTP `POST /items` (Zod Validation)** | **`3,336.70 req/s` (>Hono)** | `3,062.38 req/s` | `3,435.71 req/s` | `6,454.94 req/s` | `6,760.82 req/s` | `4,498.12 req/s` |
| **Cold Startup Median (`5` subprocesses)** | **`61.01 ms` (#1)** | `61.44 ms` | `163.92 ms` | **`11.08 ms`** | `10.79 ms` | `112.25 ms` |

- **Node.js `v22.23.5`:** **#1 fastest** across **all 3 in-process `app.fetch` pipelines** (`2.42x` Hono and `20.9x` Fastify on static JSON; `2.61x` Hono on 5-middleware chains; `1.24x` Hono on Zod validated `POST /items`), **#1 fastest on 3/4 live HTTP scenarios** (and ahead of Hono on all 4), and **#1 fastest cold startup** (`61.01 ms`, `2.69x` faster than Fastify).
- **Bun `1.4.4`:** **#1 fastest** across **all 3 in-process `app.fetch` pipelines** (`721,724 ops/s` static JSON — `1.37x` Hono & `16.2x` Fastify; `446,581 ops/s` 5-middleware — `2.18x` Hono; `244,320 ops/s` Zod POST — `1.14x` Hono), **#1 fastest live HTTP** on Param+Query (`7,862.83 req/s`) and 5-Middleware (`8,216.07 req/s`, `+17.3%` over Hono), ahead of Fastify on all 4 live HTTP scenarios, with an **`11.08 ms`** cold startup (`10.1x` faster than Fastify) and the **lowest Bun memory footprint** (`185.72 MB` idle / `193.60 MB` loaded RSS, `9.74 MB` heap).

## Documentation (`22 / 22` Verified Executable Examples · `44 / 44` Node & Bun Runs)

- [Documentation Index](./docs/README.md)
- **English Guides:** [Quick Start](./docs/quick-start.md) · [Architecture & Plugins](./docs/architecture.md) · [HTTP, Validation, OpenAPI & WebSockets](./docs/http-and-validation.md) · [Database, Auth & Authorization](./docs/data-and-auth.md) · [Security & Observability](./docs/security-and-observability.md) · [Cache, Queue, Storage, CLI & Edge](./docs/infrastructure-and-cli.md)
- **Panduan Bahasa Indonesia:** [Memulai Cepat](./docs/id/quick-start.md) · [Arsitektur & Plugin](./docs/id/architecture.md) · [Keamanan (OWASP ASVS 5.0.0)](./docs/id/security.md)
- **Benchmarks & Engineering Records:** [Reproducible Benchmarks](./benchmarks/RESULTS.md) · [Implementation Status](./IMPLEMENTATION_STATUS.md) · [Test Results](./TEST_RESULTS.md)
