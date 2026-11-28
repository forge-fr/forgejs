# Testing

> Test HTTP routes, WebSockets, DI overrides, and plugins fast in memory with identical behavior on Node.js and Bun.

- **Section**: Testing & Production
- **Packages**: @forge-fr/testing
- **Version**: v1.0.0
- **Updated**: 2026-11-27
- **HTML URL**: https://github.com/forge-fr/forgejs/docs/deployment/testing
- **Markdown URL**: https://github.com/forge-fr/forgejs/docs/deployment/testing.md
- **Source**: https://github.com/forge-fr/forgejs/blob/main/TESTING_STRATEGY.md

## Fast in-memory testing toolkit

- createTestClient(app) tests full routing, middleware, hooks, body limits, and validation without opening a network port.
- overrideProvider() swaps real repositories or external API clients with test doubles in one line.
- createMemoryWebSocketPair() tests WebSocket auth guards and live messages reliably in memory.
- createPluginTestHarness() verifies plugin config validation, exports, health checks, and shutdown hooks in isolation.

**File: `tests/orders.test.ts`**

```ts
import assert from 'node:assert/strict';
import { createKernel, createToken } from '@forge-fr/core';
import { createHttpApp } from '@forge-fr/http';
import { createTestClient, overrideProvider } from '@forge-fr/testing';

const TaxRateToken = createToken<number>('TaxRate');
const kernel = createKernel({
  providers: [{ token: TaxRateToken, scope: 'singleton', useValue: 0.2 }],
});

overrideProvider(kernel.container, TaxRateToken, 0.1);
await kernel.start();

const app = createHttpApp({ kernel });
app.get('/tax', (ctx) => ctx.json({ rate: ctx.container!.resolve(TaxRateToken) }));

const client = createTestClient(app);
const res = await client.get('/tax');
assert.deepEqual(await res.json(), { rate: 0.1 });
await client.close();
```
