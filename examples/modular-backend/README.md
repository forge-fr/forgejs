# ForgeJS Modular Backend Example (@forge-fr/*)

Complete multi-tenant modular backend demonstrating:
- Kernel DI & domain modules (`auth`, `security`, `tasks`, `attachments`, `webhooks`, `realtime`, `system`)
- Argon2id, JWT, HttpOnly sessions, Scoped API keys, and OAuth2 PKCE
- RBAC/ABAC tenant isolation, rate limiting, CSRF, SSRF & path-confinement guards
- Tag-invalidated caching, magic-byte storage, async queue + DLQ replay, WebSockets/SSE, OpenTelemetry, and OpenAPI 3.1

## Run

```bash
npm install
npm start
```

Follow the full 9-step walkthrough in [`docs/tutorials/playground-backend.md`](../../docs/tutorials/playground-backend.md).
