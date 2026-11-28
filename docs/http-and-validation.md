# HTTP Engine, Validation, OpenAPI 3.1 & WebSockets

## 1. Standard Schema Validation (Zod v4 & Valibot v1)

`@forge-fr/validation` checks URL `params`, `query`, `headers`, and size-limited JSON `body` inputs using any Standard Schema library (such as Zod v4 or Valibot v1), and removes unsafe `__proto__`/`constructor`/`prototype` keys automatically:

```ts forge-example
import assert from 'node:assert/strict';
import { createHttpApp } from '@forge-fr/http';
import { createTestClient } from '@forge-fr/testing';
import { validatedHandler } from '@forge-fr/validation';
import * as v from 'valibot';
import { z } from 'zod';

const app = createHttpApp();

app.post(
  '/projects/:projectId/tasks',
  validatedHandler(
    {
      params: z.object({ projectId: z.string().min(2) }),
      query: v.object({ dryRun: v.optional(v.string()) }),
      body: z.object({ title: z.string().min(3) }),
    },
    (ctx, input) =>
      ctx.json({
        projectId: input.params.projectId,
        dryRun: input.query.dryRun === 'true',
        title: input.body.title,
      }),
  ),
);

const client = createTestClient(app);

const invalid = await client.post('/projects/p1/tasks', {
  json: { title: 'x' },
});
assert.equal(invalid.status, 400);

const valid = await client.post('/projects/p1/tasks?dryRun=true', {
  json: { title: 'Ship OpenAPI' },
});
assert.equal(valid.status, 200);
assert.deepEqual(await valid.json(), {
  projectId: 'p1',
  dryRun: true,
  title: 'Ship OpenAPI',
});

await client.close();
```

## 2. OpenAPI 3.1 Generation & Swagger UI (`@forge-fr/openapi`)

Turn your Zod or Valibot route schemas straight into an OpenAPI 3.1 spec (`/openapi.json`) and a safe Swagger UI page (`/docs`):

```ts forge-example
import assert from 'node:assert/strict';
import { createHttpApp } from '@forge-fr/http';
import {
  generateOpenApiDocument,
  registerOpenApiRoutes,
  validatedOpenApiHandler,
} from '@forge-fr/openapi';
import { createTestClient } from '@forge-fr/testing';
import { z } from 'zod';

const app = createHttpApp();

app.get(
  '/items/:id',
  validatedOpenApiHandler(
    {
      params: z.object({ id: z.string() }),
      response: z.object({ id: z.string(), name: z.string() }),
    },
    (_ctx, input) => ({ id: input.params.id, name: 'Widget' }),
    { operationId: 'getItem', summary: 'Fetch item by ID', tags: ['Items'] },
  ),
);

registerOpenApiRoutes(app, {
  title: 'Forge Store API',
  version: '0.1.0',
});

const doc = generateOpenApiDocument(app, { title: 'Forge Store API', version: '0.1.0' });
assert.equal(doc.openapi, '3.1.0');
assert.equal(doc.paths['/items/{id}']?.get?.operationId, 'getItem');

const client = createTestClient(app);
const docsRes = await client.get('/docs');
assert.equal(docsRes.status, 200);
assert.ok(docsRes.headers.get('content-security-policy')?.includes("object-src 'none'"));
await client.close();
```

## 3. Cross-Runtime WebSockets with Pre-Upgrade Auth & Origin Guard

WebSocket routes check the allowed `Origin` list (stopping cross-site hijacking) and run your `authenticate` check *before* upgrading the connection:

```ts forge-example
import assert from 'node:assert/strict';
import { createHttpApp } from '@forge-fr/http';
import { createMemoryWebSocketPair } from '@forge-fr/testing';

const app = createHttpApp();

app.ws(
  '/ws/chat/:room',
  {
    authenticate(ctx) {
      return ctx.headers.get('authorization') === 'Bearer secret';
    },
    onOpen(ws) {
      ws.send(`joined:${ws.params['room']}`);
    },
    onMessage(ws, message) {
      ws.send(`echo:${String(message)}`);
    },
  },
  { allowedOrigins: ['https://app.example.com'], maxPayloadBytes: 64 },
);

const blocked = await app.authorizeWebSocketUpgrade(
  new Request('http://localhost/ws/chat/core', {
    headers: {
      upgrade: 'websocket',
      connection: 'Upgrade',
      origin: 'https://untrusted.example',
      authorization: 'Bearer secret',
    },
  }),
);
assert.equal(blocked.accepted, false);
if (!blocked.accepted) {
  assert.equal(blocked.response.status, 403);
}

const allowed = await app.authorizeWebSocketUpgrade(
  new Request('http://localhost/ws/chat/core', {
    headers: {
      upgrade: 'websocket',
      connection: 'Upgrade',
      origin: 'https://app.example.com',
      authorization: 'Bearer secret',
    },
  }),
);
assert.equal(allowed.accepted, true);
if (allowed.accepted) {
  const { client, attachServer } = createMemoryWebSocketPair();
  const messages: unknown[] = [];
  client.onMessage((msg) => messages.push(msg));
  attachServer(allowed.route, allowed.upgradeContext);
  client.send('hello');
  assert.deepEqual(messages, ['joined:core', 'echo:hello']);
}
```

## 4. Response Compression & Conditional Caching (`ETag` / `304`)

Compress responses with built-in Web `CompressionStream` (`gzip` / `deflate`) under safe size limits, and return `304 Not Modified` automatically using SHA-256 `ETag` headers:

```ts forge-example
import assert from 'node:assert/strict';
import {
  createCompressionMiddleware,
  createEtagMiddleware,
  createHttpApp,
} from '@forge-fr/http';
import { createTestClient } from '@forge-fr/testing';

const app = createHttpApp();
app.use(createCompressionMiddleware({ thresholdBytes: 64, maxBytes: 1_048_576 }));
app.use(createEtagMiddleware());

app.get('/catalog', (ctx) =>
  ctx.json({ items: ['core', 'http', 'edge'], summary: 'x'.repeat(120) }),
);

const client = createTestClient(app);
const first = await client.get('/catalog', {
  headers: { 'accept-encoding': 'gzip' },
});
assert.equal(first.status, 200);
assert.equal(first.headers.get('content-encoding'), 'gzip');
const etag = first.headers.get('etag');
assert.ok(etag);

const cached = await client.get('/catalog', {
  headers: { 'if-none-match': etag },
});
assert.equal(cached.status, 304);
await client.close();
```

## 5. How ForgeJS Keeps Request Handling Fast

ForgeJS trims unnecessary per-request work at every step while staying 100% compatible with standard Web APIs:

1. **Fast Static & Dynamic Routing (`@forge-fr/router`):** Exact static routes match in constant O(1) time before path cleanup, while dynamic routes reuse internal buffers to cut memory allocations.
2. **Lazy Request Context (`@forge-fr/http`):** URL paths and query strings are read directly from `request.url` without creating heavy `URL` objects on every call. Extras like parsed headers, loggers, and `requestId` are created only when your handler actually uses them.
3. **Runtime-Aware Response Helpers (`@forge-fr/http`):** `ctx.json()`, `ctx.text()`, `ctx.html()`, and `ctx.empty()` use lightweight response paths on Node.js and pre-built header presets on Bun, while always returning native `Response` instances where runtimes (like Cloudflare Workers) require them.
4. **Cached Middleware Pipelines & Direct Zod Fast Path (`@forge-fr/http`, `@forge-fr/validation`):** Middleware pipelines are compiled once per route instead of rebuilt on each request. Synchronous Zod v4 schemas call `safeParse()` directly for extra speed, falling back cleanly to Standard Schema `validate()` for async checks, Valibot, ArkType, or custom validators.
5. **Thin Native Adapters (`@forge-fr/node`, `@forge-fr/bun`):** The Node.js and Bun adapters stream directly to each runtime's native HTTP server with clean in-flight request tracking for zero-drop shutdowns.

