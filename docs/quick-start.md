# Quick Start

ForgeJS gives you two easy starting paths on the exact same Web Standards engine: a **Simple HTTP API** for small services, and a **Modular API** with private feature modules for growing apps.

## 1. Simple HTTP API (`@forge-fr/http`)

Add routes with URL parameters, attach middleware, and test everything fast in memory using `@forge-fr/testing`:

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

Group features into self-contained modules where internal helpers stay private and only exported tokens are shared:

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

Switch between Node.js (`@forge-fr/node`) and Bun (`@forge-fr/bun`) by changing just the adapter line — your routes stay the same:

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
