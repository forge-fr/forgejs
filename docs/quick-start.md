# Quick Start

ForgeJS supports two progressive entry paths over the exact same Web Standards engine: **Simple API** for lightweight HTTP services and **Modular API** with encapsulated Dependency Injection modules for larger systems.

## 1. Simple HTTP API (`@forge-fr/http`)

Mount routes with radix parameters, priority middleware, and run zero-socket integration tests with `@forge-fr/testing`:

```ts forge-example
import assert from 'node:assert/strict';
import { createHttpApp } from '@forge-fr/http';
import { createTestClient } from '@forge-fr/testing';

const app = createHttpApp();

app.use(async (ctx, next) => {
  ctx.setHeader('x-powered-by-forge', '0.1.0');
  return await next();
});

app.get('/hello/:name', (ctx) =>
  ctx.json({
    greeting: `Hello, ${ctx.params['name'] ?? 'world'}`,
    lang: ctx.query['lang'] ?? 'en',
  }),
);

const client = createTestClient(app);
const res = await client.get('/hello/Forge?lang=id');

assert.equal(res.status, 200);
assert.equal(res.headers.get('x-powered-by-forge'), '0.1.0');
assert.deepEqual(await res.json(), {
  greeting: 'Hello, Forge',
  lang: 'id',
});

await client.close();
```

## 2. Modular API with Typed DI (`@forge-fr/core` + `@forge-fr/http`)

Organize features into encapsulated modules where only explicitly exported tokens are visible to consumers:

```ts forge-example
import assert from 'node:assert/strict';
import { createToken, defineModule } from '@forge-fr/core';
import { createHttpApp } from '@forge-fr/http';
import { createTestClient } from '@forge-fr/testing';

interface GreetingService {
  greet(target: string): string;
}

const PrefixToken = createToken<string>('greeting.prefix');
const GreetingServiceToken = createToken<GreetingService>('greeting.service');

const GreetingModule = defineModule({
  name: 'greeting',
  providers: [
    { token: PrefixToken, useValue: 'Welcome' },
    {
      token: GreetingServiceToken,
      useFactory: (resolver) => {
        const prefix = resolver.resolve(PrefixToken);
        return { greet: (target: string) => `${prefix}, ${target}!` };
      },
    },
  ],
  exports: [GreetingServiceToken],
});

const app = createHttpApp({ modules: [GreetingModule] });

app.get('/greet/:name', (ctx) => {
  const service = ctx.resolve(GreetingServiceToken);
  return ctx.json({ message: service.greet(ctx.params['name'] ?? 'guest') });
});

const client = createTestClient(app);
const response = await client.get('/greet/Nadia');
assert.equal(response.status, 200);
assert.deepEqual(await response.json(), { message: 'Welcome, Nadia!' });

await client.close();
```

## 3. Running on Native Node.js & Bun Servers

Swap only the adapter (`@forge-fr/node` or `@forge-fr/bun`) without changing application code:

```ts forge-example
import assert from 'node:assert/strict';
import { createHttpApp } from '@forge-fr/http';
import { createNodeAdapter } from '@forge-fr/node';

const app = createHttpApp({ adapter: createNodeAdapter() });
app.get('/ping', (ctx) => ctx.text('pong'));

const addr = await app.listen({ host: '127.0.0.1', port: 0 });
try {
  const res = await fetch(`${addr.url}/ping`);
  assert.equal(res.status, 200);
  assert.equal(await res.text(), 'pong');
} finally {
  await app.close();
}
```
