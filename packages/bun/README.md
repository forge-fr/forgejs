# @forge-fr/bun

Native Bun (`Bun.serve()`) runtime adapter for **ForgeJS**.

## Features

- Delegates directly to `Bun.serve()` with zero third-party runtime dependencies and zero `node:*` imports.
- Maps `server.requestIP(request)` to `ctx.remoteAddress` and propagates `request.signal` to `ctx.signal`.
- Configures `maxRequestBodySize` and `idleTimeout` from `ListenOptions`.
- Drains active requests gracefully via `server.stop(false)` with timeout fallback to `server.stop(true)`.
- Fails explicitly with `BUN_RUNTIME_REQUIRED` if executed outside Bun.

## Usage

```ts
import { createHttpApp } from '@forge-fr/http';
import { createBunAdapter } from '@forge-fr/bun';

const app = createHttpApp({ adapter: createBunAdapter() });
app.get('/health', (ctx) => ctx.json({ ok: true }));

const addr = await app.listen({ port: 3000, host: '127.0.0.1' });
console.log(`Listening on ${addr.url}`);
```

## License

MIT
