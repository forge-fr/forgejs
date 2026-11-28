# Quick Start

> Create a validated HTTP API with createHttpApp() and validatedHandler(), then run the same code on Node.js, Bun, or Edge.

- **Section**: Getting Started
- **Packages**: @forge-fr/http, @forge-fr/validation, @forge-fr/node, @forge-fr/bun, @forge-fr/edge
- **Version**: v1.0.0
- **Updated**: 2026-11-27
- **HTML URL**: https://github.com/forge-fr/forgejs/docs/getting-started/quick-start
- **Markdown URL**: https://github.com/forge-fr/forgejs/docs/getting-started/quick-start.md
- **Source**: https://github.com/forge-fr/forgejs/blob/main/docs/quick-start.md

## Build your first validated API

Your routes, input validation, middleware, and error handling stay the same no matter where you deploy. Only the small runtime adapter import at the top changes.

**Node.js (`src/server.ts`)**

```ts
import { createHttpApp } from '@forge-fr/http';
import { createNodeAdapter, attachProcessShutdown } from '@forge-fr/node';
import { validatedHandler } from '@forge-fr/validation';
import { z } from 'zod';

const app = createHttpApp();

app.get('/health', (ctx) => ctx.json({ ok: true, runtime: 'node' }));

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

const server = await app.listen(createNodeAdapter(), { host: '127.0.0.1', port: 3000 });
attachProcessShutdown(server);
```

**Bun (`src/server.ts`)**

```ts
import { createHttpApp } from '@forge-fr/http';
import { createBunAdapter, attachProcessShutdown } from '@forge-fr/bun';
import { validatedHandler } from '@forge-fr/validation';
import { z } from 'zod';

const app = createHttpApp();

app.get('/health', (ctx) => ctx.json({ ok: true, runtime: 'bun' }));

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

const server = await app.listen(createBunAdapter(), { host: '127.0.0.1', port: 3000 });
attachProcessShutdown(server);
```

**Cloudflare / Edge (`src/worker.ts`)**

```ts
import { createHttpApp } from '@forge-fr/http';
import { createCloudflareWorkerHandler } from '@forge-fr/edge';
import { validatedHandler } from '@forge-fr/validation';
import { z } from 'zod';

const app = createHttpApp();

app.get('/health', (ctx) => ctx.json({ ok: true, runtime: 'edge' }));

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

export default createCloudflareWorkerHandler(app);
```

## Test routes in memory without opening a port

Pass your app directly to createTestClient(app) from @forge-fr/testing to test routes, middleware, body size limits, and validation fast in memory.

**File: `tests/health.test.ts`**

```ts
import assert from 'node:assert/strict';
import { createHttpApp } from '@forge-fr/http';
import { createTestClient } from '@forge-fr/testing';

const app = createHttpApp();
app.get('/health', (ctx) => ctx.json({ ok: true }));

const client = createTestClient(app);
const res = await client.get('/health');
assert.equal(res.status, 200);
assert.deepEqual(await res.json(), { ok: true });
await client.close();
```
