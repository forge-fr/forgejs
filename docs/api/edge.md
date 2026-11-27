# @forge-fr/edge

> WinterCG Fetch adapter for Cloudflare Workers, Deno, and isolate runtimes with zero node:* or Bun globals and waitUntil background task helpers.

- **Version**: v1.0.0-rc.1
- **Layer**: Adapter Layer
- **Category**: runtime
- **Tarball**: 8.8 kB (12 files)
- **Internal deps**: @forge-fr/http
- **Runtime deps**: zero runtime dependencies
- **Peer deps**: none
- **HTML URL**: https://github.com/forge-fr/forgejs/api/edge
- **Markdown URL**: https://github.com/forge-fr/forgejs/api/edge.md

## Installation

```bash
npm install @forge-fr/edge
```

## Runtime & Error Semantics

- **Runtime**: Zero node:* or Bun globals. Unit and Fetch/WebSocketPair contract verified; live workerd/deno binaries are not installed in local sandbox.
- **Errors**: Background promises submitted via runInEdgeBackground() use executionCtx.waitUntil when available.

## Usage Example

```ts
import { createHttpApp } from '@forge-fr/http';
import { createCloudflareWorkerHandler, getEdgeEnv } from '@forge-fr/edge';

const app = createHttpApp();
app.get('/env', (ctx) => ctx.json({ hasEnv: Boolean(getEdgeEnv(ctx.request)) }));

export default createCloudflareWorkerHandler(app);
```

## Public Exports

### WinterCG Edge Handlers & Context Helpers

- **Values**: `EdgeAdapter`, `createEdgeAdapter`, `createEdgeHandler`, `createCloudflareWorkerHandler`, `createDenoHandler`, `getEdgeEnv`, `getEdgeExecutionContext`, `runInEdgeBackground`
- **Types**: `CloudflareWorkerHandlerOptions`, `CloudflareWorkerModule`, `DenoHandlerOptions`, `DenoServeAddrLike`, `DenoServeHandlerInfoLike`, `DenoUpgradeWebSocketFn`, `EdgeAdapterOptions`, `EdgeAppTarget`, `EdgeExecutionContextLike`, `EdgeHandlerOptions`, `EdgeServerWebSocketLike`, `EdgeWebSocketPairConstructor`, `EdgeWebSocketPairLike`
