# Quick Start

> Build a schema-validated HTTP API with createHttpApp() and validatedHandler(), then swap seamlessly across Node.js, Bun, and WinterCG Edge.

- **Section**: Getting Started
- **Packages**: @forge-fr/http, @forge-fr/validation, @forge-fr/node, @forge-fr/bun, @forge-fr/edge
- **Version**: v1.0.0-rc.1
- **Updated**: 2026-11-26
- **HTML URL**: https://github.com/forge-fr/forgejs/docs/getting-started/quick-start
- **Markdown URL**: https://github.com/forge-fr/forgejs/docs/getting-started/quick-start.md
- **Source**: https://github.com/forge-fr/forgejs/blob/main/docs/quick-start.md

## Create your first validated API

Your routing, validation, middleware, and error-handling code stays 100% identical across runtimes. Only the runtime adapter import changes at the entrypoint.

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

**WinterCG Edge (`src/worker.ts`)**

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

## Test routes without binding a TCP port

Pass your ForgeHttpApp directly to createTestClient(app) from @forge-fr/testing to exercise routing, middleware, body limits, and schema validation in memory.

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
