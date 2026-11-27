# ForgeJS Playground Backend Example (`@forge-fr/*`)

Production-style multi-tenant backend powering the live ForgeJS Playground ([interactive demo](https://forgejs.dev/playground)), built exclusively with ForgeJS framework packages (no frontend code).

## Architecture

- **Domain Modules (`src/server/`):**
  - `auth/` — Argon2id / PBKDF2 password hashing, JWT, HttpOnly sessions, scoped API keys, and OAuth2 PKCE
  - `security/` — Security headers, rate limiting, CSRF, SSRF-safe outbound checks, and path-confinement guards
  - `tasks/` — Multi-tenant RBAC/ABAC CRUD + tag-invalidated `@forge-fr/cache`
  - `attachments/` — Binary magic-byte inspection + confined storage via `@forge-fr/storage`
  - `webhooks/` — Async `@forge-fr/queue` delivery worker, retries, and Dead-Letter Queue (DLQ) replay
  - `realtime/` — Tenant-scoped SSE & WebSocket event stream
  - `system/` — Structured logging (`@forge-fr/logger`), OpenTelemetry metrics/traces, health probes, and OpenAPI 3.1 + Swagger UI
- **Dual Runtime Entrypoints:**
  - **Node.js (`src/server.ts`):** Native `@forge-fr/node` HTTP & WebSocket adapter on port `3000`
  - **Cloudflare Workers / Edge (`src/worker.ts` + `wrangler.jsonc`):** Native `@forge-fr/edge` Fetch & `WebSocketPair` adapter with Web Crypto PBKDF2 (`src/cloudflare/webcrypto-password-hasher.ts`)

## Run on Node.js

Configure `.npmrc` for GitHub Packages (see root [`.npmrc.github.example`](../../.npmrc.github.example)), then run:

```bash
npm install
npm start
```

Explore the running backend:
- API Overview: `http://localhost:3000/`
- Swagger UI: `http://localhost:3000/playground-api/docs`
- OpenAPI 3.1 Spec: `http://localhost:3000/playground-api/openapi.json`
- Readiness Probe: `http://localhost:3000/playground-api/health/ready`

## Run & Deploy on Cloudflare Workers (`@forge-fr/edge`)

```bash
npm run cf:dev
npm run cf:deploy
```

## Tutorial

Follow the 9-step architecture walkthrough in [`docs/tutorials/playground-backend.md`](../../docs/tutorials/playground-backend.md).
