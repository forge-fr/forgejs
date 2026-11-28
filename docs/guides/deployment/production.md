# Production Deployment

> Production checklist covering NODE_ENV=production, graceful shutdown on SIGTERM, health checks, and reverse proxies.

- **Section**: Testing & Production
- **Packages**: @forge-fr/node, @forge-fr/bun, @forge-fr/edge, @forge-fr/logger
- **Version**: v1.0.0
- **Updated**: 2026-11-27
- **HTML URL**: https://github.com/forge-fr/forgejs/docs/deployment/production
- **Markdown URL**: https://github.com/forge-fr/forgejs/docs/deployment/production.md
- **Source**: https://github.com/forge-fr/forgejs/blob/main/docs/quick-start.md

## Production deployment checklist

- Run with NODE_ENV=production and exposeErrorDetails: false so 5xx errors and health checks hide internal server details.
- Wire attachProcessShutdown(server, { timeoutMs: 10_000 }) with kernel.shutdown() so active requests finish before exit.
- Keep trustProxy: false unless your app sits behind a trusted proxy (Nginx, Caddy, Envoy, or Cloudflare) that sets real client IPs.
- Mount /health/live and /health/ready via registerHealthRoutes() for Kubernetes or load-balancer checks.

## Node.js & Bun production entry file

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
