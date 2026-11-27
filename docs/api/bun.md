# @forge-fr/bun

> Native Bun.serve() runtime adapter with pure-HTTP fast mode, native Bun WebSockets, in-flight request draining, and POSIX shutdown handling.

- **Version**: v1.0.0-rc.1
- **Layer**: Adapter Layer
- **Category**: runtime
- **Tarball**: 11.9 kB (16 files)
- **Internal deps**: @forge-fr/http
- **Runtime deps**: zero runtime dependencies
- **Peer deps**: none
- **HTML URL**: https://github.com/forge-fr/forgejs/api/bun
- **Markdown URL**: https://github.com/forge-fr/forgejs/api/bun.md

## Installation

```bash
npm install @forge-fr/bun
```

## Runtime & Error Semantics

- **Runtime**: Requires Bun >=1.4.0 (verified locally on Bun 1.4.4). Automatically selects pure-HTTP mode when no WebSocket routes exist.
- **Errors**: Enforces maxRequestBodySize and clamped idleTimeout while draining active integer inFlightCount during shutdown.

## Usage Example

```ts
import { createHttpApp } from '@forge-fr/http';
import { createBunAdapter, attachProcessShutdown } from '@forge-fr/bun';

const app = createHttpApp();
app.get('/health', (ctx) => ctx.json({ ok: true }));

const server = await app.listen(createBunAdapter(), { host: '127.0.0.1', port: 3000 });
attachProcessShutdown(server);
```

## Public Exports

### Bun Runtime Adapter & Shutdown

- **Values**: `BunAdapter`, `createBunAdapter`, `attachProcessShutdown`
- **Types**: `BunAdapterOptions`, `BunServeLike`, `BunServeOptionsLike`, `BunServerLike`, `BunSocketAddressLike`, `ProcessLike`, `ProcessShutdownHandle`, `ProcessShutdownOptions`, `ProcessShutdownTarget`, `ShutdownSignal`
