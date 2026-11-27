# @forge-fr/testing

> In-memory HTTP and WebSocket test harness, DI provider overrides, capability-scoped plugin test harness, and shared adapter contract verification suites.

- **Version**: v1.0.0-rc.2
- **Layer**: Adapter Layer
- **Category**: tooling
- **Tarball**: 17.2 kB (32 files)
- **Internal deps**: @forge-fr/core, @forge-fr/http
- **Runtime deps**: zero runtime dependencies
- **Peer deps**: none
- **HTML URL**: https://github.com/forge-fr/forgejs/api/testing
- **Markdown URL**: https://github.com/forge-fr/forgejs/api/testing.md

## Installation

```bash
npm install @forge-fr/testing
```

## Runtime & Error Semantics

- **Runtime**: Zero third-party dependencies. Runs in-memory HTTP, WebSocket, DI override, and plugin tests without binding TCP sockets.
- **Errors**: Adapter contract suites report detailed per-check failure objects rather than silent skips.

## Usage Example

```ts
import { createHttpApp } from '@forge-fr/http';
import { createTestClient } from '@forge-fr/testing';

const app = createHttpApp();
app.get('/ping', (ctx) => ctx.json({ ok: true }));

const client = createTestClient(app);
const res = await client.get('/ping');
await client.close();
```

## Public Exports

### Test Clients, Harnesses & Contract Suites

- **Values**: `MemoryAdapter`, `createTestClient`, `overrideProvider`, `runHttpAdapterContractSuite`, `createPluginTestHarness`, `createMemoryWebSocketPair`, `runWebSocketContractSuite`
- **Types**: `TestClient`, `TestClientOptions`, `TestRequestOptions`, `TestResponse`, `ProviderTarget`, `AdapterContractCheckResult`, `PluginTestHarness`, `PluginTestHarnessOptions`, `MemoryWebSocketClient`, `MemoryWebSocketPair`
