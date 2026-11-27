# HTTP Engine, Validation, OpenAPI 3.1 & WebSockets

## 1. Standard Schema Validation (Zod v4 & Valibot v1)

`@forge-fr/validation` validates URL `params`, `query`, `headers`, and bounded JSON `body` payloads through `@standard-schema/spec`, stripping `__proto__`/`constructor`/`prototype` keys automatically:

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

Reflect Zod/Valibot schemas directly into JSON Schema 2020-12 and mount hardened Swagger UI (`/docs`) + spec (`/openapi.json`):

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

WebSocket routes enforce Origin allowlists (CSWSH protection) and authentication *before* upgrading to `101 Switching Protocols`:

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

Use Web Standards `CompressionStream` (`gzip`/`deflate`) with bounded buffering alongside SHA-256 `ETag` `304 Not Modified` responses:

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

## 5. Zero-Allocation Hot-Path Architecture

ForgeJS optimizes every stage of the request/response lifecycle while remaining 100% Web Standards compliant:

1. **Pre-Normalization O(1) Static Route Cache & Scratch Radix Matching (`@forge-fr/router`):** Exact static paths check `staticByMethod[method]?.get(rawPath)` before calling `normalizePathname()`, while dynamic Radix matching reuses a module-level scratch capture array and zero-allocation `collectAllowedMethodsFromString`.
2. **Zero-Allocation URL Slicing, Compact 13-Field `ForgeContext` & Lazy `requestId` (`@forge-fr/http`):** Pathnames and query strings are sliced directly from `request.url` without `new URL()` or `URLSearchParams`. `ForgeContextImpl` holds only 13 hot fields (sharing `ContextAppConfig` and lazily creating cold state for `url`, `query`, `headers`, `logger`, `signal`, and `scope`), and `requestId` / `x-request-id` headers are generated on demand (when `ctx.requestId` is read, on errors, or when `trustRequestId: true` matches an incoming header).
3. **Lazy Node `FastResponse` & Pre-Allocated Bun `Headers` (`@forge-fr/http`):** On Node.js, `ctx.json()`, `ctx.text()`, `ctx.html()`, and `ctx.empty()` return a lightweight `Response.prototype`-inheriting `FastResponse` with lazy `_fastHeaders` (bypassing Undici C++ constructors); on Bun, native `new Response(body, init)` reuses pre-allocated `GlobalHeaders` presets (`BUN_JSON_200_INIT`, `BUN_TEXT_200_INIT`, `BUN_HTML_200_INIT`) for `2.16x` faster construction with full header mutation isolation.
4. **Inline Route Pipeline Cache & Compiled Fast Validation (`@forge-fr/http`, `@forge-fr/validation`):** Compiled middleware pipelines are cached directly on each route object (`route._pipelineRun` / `route._pipelineVersion`, replacing `WeakMap` lookups) with synchronous-first `composeMiddleware` and zero-overhead completion when no outer hooks are registered. `compileFastValidator()` detects Standard Schema once at route registration and invokes Zod v4 `safeParse()` directly (`2.6x` faster than `~standard.validate`) paired with a sync-first native `request.json()` + in-memory prototype-pollution key scan, falling back automatically to Standard Schema `validate()` for async refinements, Valibot, ArkType, or custom schemas.
5. **Direct-Meta Node & Pure-HTTP Bun Adapters (`@forge-fr/node`, `@forge-fr/bun`):** `FastNodeRequest` implements `RuntimeRequestMeta` directly (eliminating per-request meta wrappers and eager `fullUrl` concatenation), and `writeFastResponseSync` reuses static header objects plus `trySetNodeContentLength()` for single-call TCP writes. `BunAdapter` enables pure-HTTP `Bun.serve()` mode when no WebSocket routes are registered, replaces `Set<Promise>` tracking with integer `inFlightCount` draining, and reuses a single cached `RuntimeRequestMeta` per server for `ForgeHttpApp` handlers.

