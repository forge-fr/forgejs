# Production Deployment

> Strict ESM builds, NODE_ENV=production hardening, POSIX graceful draining, health probes, and reverse-proxy configuration.

- **Section**: Testing & Production
- **Packages**: @forge-fr/node, @forge-fr/bun, @forge-fr/edge, @forge-fr/logger
- **Version**: v1.0.0-rc.2
- **Updated**: 2026-11-26
- **HTML URL**: https://github.com/forge-fr/forgejs/docs/deployment/production
- **Markdown URL**: https://github.com/forge-fr/forgejs/docs/deployment/production.md
- **Source**: https://github.com/forge-fr/forgejs/blob/main/docs/quick-start.md

## Production deployment checklist

- Run with NODE_ENV=production and exposeErrorDetails: false so unknown 5xx errors and readiness probes sanitize internal diagnostics.
- Attach attachProcessShutdown(server, { timeoutMs: 10_000 }) alongside kernel.shutdown() for zero-drop SIGTERM/SIGINT draining.
- Keep trustProxy: false unless behind a trusted reverse proxy (Nginx, Caddy, Envoy, Cloudflare) that overwrites client IP headers.
- Mount /health/live (liveness) and /health/ready (readiness) via registerHealthRoutes() for container orchestrator probes.

## Node.js & Bun production entrypoint

**Node.js (`src/index.ts`)**

```ts
import { createNodeAdapter, attachProcessShutdown } from '@forge-fr/node';
import { app, kernel } from './app.js';

await kernel.start();
const server = createNodeAdapter(app);
await server.listen({ host: '0.0.0.0', port: Number(process.env.PORT ?? 3000) });

attachProcessShutdown(server, {
  timeoutMs: 10_000,
  onAfterStop: async () => {
    await kernel.shutdown();
  },
});
```

**Bun (`src/index.ts`)**

```ts
import { createBunAdapter, attachProcessShutdown } from '@forge-fr/bun';
import { app, kernel } from './app.js';

await kernel.start();
const server = createBunAdapter(app);
await server.listen({ host: '0.0.0.0', port: Number(process.env.PORT ?? 3000) });

attachProcessShutdown(server, {
  timeoutMs: 10_000,
  onAfterStop: async () => {
    await kernel.shutdown();
  },
});
```
