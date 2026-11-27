# Runtime Compatibility

> Transparent compatibility matrix separating locally verified runtimes (Node.js v22.23.5, Bun 1.4.4) from CI-configured targets.

- **Section**: Testing & Production
- **Packages**: @forge-fr/node, @forge-fr/bun, @forge-fr/edge
- **Version**: v1.0.0-rc.2
- **Updated**: 2026-11-26
- **HTML URL**: https://github.com/forge-fr/forgejs/docs/deployment/runtime-compatibility
- **Markdown URL**: https://github.com/forge-fr/forgejs/docs/deployment/runtime-compatibility.md
- **Source**: https://github.com/forge-fr/forgejs/blob/main/RUNTIME_COMPATIBILITY.md

## Verified & configured runtime matrix

| Runtime | Declared Target | Local Verification | CI Matrix |
| --- | --- | --- | --- |
| Node.js 22 LTS | >= 22.18.0 | Verified locally (v22.23.5 — 21/21 smoke) | ubuntu · macos · windows |
| Bun 1.4+ | >= 1.4.0 | Verified locally (1.4.4 — 23/23 smoke) | ubuntu · macos (1.4.4) |
| WinterCG Edge | Web Fetch API | Unit & contract verified (no local workerd/deno binary) | Included in Node & Bun jobs |
| Node.js 24 LTS | >= 22.18.0 | Not installed locally | ubuntu-latest (Node 24) |
| PostgreSQL 16 | postgres-js / Drizzle / Prisma | Skipped locally (no Docker daemon) | postgres:16-alpine service job |

## Cloudflare Workers & Deno Deploy (@forge-fr/edge)

**File: `src/edge.ts`**

```ts
import { createCloudflareWorkerHandler, createDenoHandler, getEdgeEnv } from '@forge-fr/edge';
import { createHttpApp } from '@forge-fr/http';

const app = createHttpApp();
app.get('/region', (ctx) => {
  const env = getEdgeEnv<{ readonly REGION: string }>(ctx.request);
  return ctx.json({ runtime: ctx.runtime, region: env?.REGION ?? 'local' });
});

export default createCloudflareWorkerHandler<{ readonly REGION: string }>(app, {
  trustCfConnectingIp: true,
});
export const denoHandler = createDenoHandler(app);
```
