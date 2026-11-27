# Testing

> In-memory HTTP/WebSocket tests, DI provider overrides, plugin harnesses, and dual-runtime Node.js + Bun verification.

- **Section**: Testing & Production
- **Packages**: @forge-fr/testing
- **Version**: v1.0.0-rc.1
- **Updated**: 2026-11-26
- **HTML URL**: https://github.com/forge-fr/forgejs/docs/deployment/testing
- **Markdown URL**: https://github.com/forge-fr/forgejs/docs/deployment/testing.md
- **Source**: https://github.com/forge-fr/forgejs/blob/main/TESTING_STRATEGY.md

## Fast in-memory HTTP, DI & WebSocket testing

- createTestClient(app) exercises full routing, tiered middleware, hooks, body limits, and schema validation without binding TCP sockets.
- overrideProvider() swaps repositories or external services cleanly inside the DI container.
- createMemoryWebSocketPair() tests real-time WebSocket upgrades, auth guards, and message frames deterministically.
- createPluginTestHarness() verifies plugin configuration schemas, exports, health probes, and shutdown hooks in isolation.

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
