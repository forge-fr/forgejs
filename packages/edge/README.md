# `@forge-fr/edge`

Runtime-agnostic WinterCG Edge runtime adapter and handlers for **ForgeJS** (Cloudflare Workers, Deno, and standard Web Fetch runtimes).

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
