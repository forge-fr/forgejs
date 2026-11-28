# @forge-fr/node

> Node.js HTTP server adapter with fast direct request handling, native WebSocket upgrades, and clean shutdown on SIGINT/SIGTERM.

- **Version**: v1.0.0
- **Layer**: Adapter Layer
- **Category**: runtime
- **Tarball**: 22.6 kB (20 files)
- **Internal deps**: @forge-fr/http
- **Runtime deps**: zero runtime dependencies
- **Peer deps**: none
- **HTML URL**: https://github.com/forge-fr/forgejs/api/node
- **Markdown URL**: https://github.com/forge-fr/forgejs/api/node.md

## Installation

```bash
# Add once to .npmrc: @forge-fr:registry=https://npm.pkg.github.com
npm install @forge-fr/node
```

## Runtime & Error Semantics

- **Runtime**: Requires Node.js >=22.18.0 (verified locally on v22.23.5). Uses native node:http and zero-dep RFC 6455 WebSockets.
- **Errors**: Propagates client disconnects via AbortSignal and drains active connections cleanly on SIGINT/SIGTERM via attachProcessShutdown.

## Usage Example

```ts
import { createHttpApp } from '@forge-fr/http';
import { createNodeAdapter, attachProcessShutdown } from '@forge-fr/node';

const app = createHttpApp();
app.get('/health', (ctx) => ctx.json({ ok: true }));

const server = await app.listen(createNodeAdapter(), { host: '127.0.0.1', port: 3000 });
attachProcessShutdown(server);
```

## Public Exports

### Node.js Runtime Adapter & Shutdown

- **Values**: `NodeAdapter`, `createNodeAdapter`, `attachProcessShutdown`
- **Types**: `NodeAdapterOptions`, `ProcessLike`, `ProcessShutdownHandle`, `ProcessShutdownOptions`, `ProcessShutdownTarget`, `ShutdownSignal`
