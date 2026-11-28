# ForgeJS Playground Backend Example (`@forge-fr/*`)

A complete multi-tenant backend powering the live ForgeJS Playground ([try the interactive demo](https://forgejs.id/playground)), built using only ForgeJS backend packages (no frontend code).

## What Is Inside

- **Feature Modules (`src/server/`):**
  - `auth/` — Secure password hashing, JWTs, HttpOnly sessions, scoped API keys, and OAuth2 PKCE
  - `security/` — Security headers, rate limiting, CSRF protection, SSRF URL checks, and safe file paths
  - `tasks/` — Multi-tenant task CRUD with role/ownership checks and tag-invalidated `@forge-fr/cache`
  - `attachments/` — File upload checks (magic bytes + size limits) via `@forge-fr/storage`
  - `webhooks/` — Background job delivery, automatic retries, and Dead-Letter Queue replay via `@forge-fr/queue`
  - `realtime/` — Tenant-scoped Server-Sent Events (SSE) and WebSockets
  - `system/` — Redacted structured logs (`@forge-fr/logger`), OpenTelemetry tracing, health probes, and OpenAPI 3.1 + Swagger UI
- **Two Ready-to-Run Entrypoints:**
  - **Node.js (`src/server.ts`):** Uses `@forge-fr/node` on port `3000`
  - **Cloudflare Workers / Edge (`src/worker.ts` + `wrangler.jsonc`):** Uses `@forge-fr/edge` with Web Crypto password hashing (`src/cloudflare/webcrypto-password-hasher.ts`)

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
