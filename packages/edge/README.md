# `@forge-fr/edge`

Runtime-agnostic WinterCG Edge runtime adapter and handlers for **ForgeJS** (Cloudflare Workers, Deno, and standard Web Fetch runtimes) with zero `node:*` or `Bun.*` imports.

## Features

- **`createCloudflareWorkerHandler()` / `createEdgeHandler()` / `createDenoHandler()`:** Bridges ForgeJS HTTP apps and WebSocket routes (`WebSocketPair`) cleanly to Edge runtimes.
- **Native WebIDL `Response` Guarantee (`v1.0.0-rc.2`):** Normalizes all outgoing responses via `toNativeResponse()` so strict `workerd` and Deno fetch pipelines always receive true native `globalThis.Response` instances.
- **Bindings & Background Tasks:** Access Worker bindings via `getEdgeEnv(req)` and schedule non-blocking tasks via `runInEdgeBackground(req, promise)` backed by `executionCtx.waitUntil()`.

## Usage

```ts
import { createHttpApp } from '@forge-fr/http';
import { createCloudflareWorkerHandler } from '@forge-fr/edge';

const app = createHttpApp();
app.get('/hello', (ctx) => ctx.json({ runtime: ctx.runtime }));

export default createCloudflareWorkerHandler(app, {
  trustCfConnectingIp: true,
});
```

## License

MIT
