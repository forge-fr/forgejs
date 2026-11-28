# @forge-fr/testing

> First-class testing harness with createTestKernel/createTestApp, typed DI overrides, in-memory HTTP/SSE/multipart/cookie-jar TestClient, and WebSocket pairs.

- **Version**: v1.0.0
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
# Add once to .npmrc: @forge-fr:registry=https://npm.pkg.github.com
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

- **Values**: `MemoryAdapter`, `createTestClient`, `createTestApp`, `createTestKernel`, `overrideProvider`, `overrideValue`, `overrideFactory`, `applyOverrides`, `isTypedProviderOverride`, `runHttpAdapterContractSuite`, `createPluginTestHarness`, `createMemoryWebSocketPair`, `runWebSocketContractSuite`
- **Types**: `TestApp`, `TestAppOptions`, `TestClient`, `TestClientOptions`, `TestKernel`, `TestKernelOptions`, `TestOverride`, `TestRequestOptions`, `TestResponse`, `TestSseResponse`, `ParsedSseMessage`, `TypedProviderOverride`, `TestMultipartFile`, `TestMultipartFieldValue`, `ProviderTarget`, `AdapterContractCheckResult`, `PluginTestHarness`, `PluginTestHarnessOptions`, `MemoryWebSocketClient`, `MemoryWebSocketPair`
