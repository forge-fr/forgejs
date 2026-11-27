# @forge-fr/node

Native Node.js (`node:http`) runtime adapter for **ForgeJS**.

## Features

- Translates Node.js `IncomingMessage` / `ServerResponse` to and from Web Standards `Request` / `Response` with zero third-party runtime dependencies.
- Backpressure-safe `ReadableStream` piping for chunked responses and Server-Sent Events (SSE).
- Multi-value `Set-Cookie` preservation (`headers.getSetCookie()`).
- Client disconnect/abort propagation to `ctx.signal`.
- Adapter-level `maxBodyBytes` enforcement and sanitized `Host` header handling.
- Graceful connection draining (`closeIdleConnections()` + timeout fallback to `closeAllConnections()`).

## Usage

```ts
import { createHttpApp } from '@forge-fr/http';
import { createNodeAdapter } from '@forge-fr/node';

const app = createHttpApp({ adapter: createNodeAdapter() });
app.get('/health', (ctx) => ctx.json({ ok: true }));

const addr = await app.listen({ port: 3000, host: '127.0.0.1' });
console.log(`Listening on ${addr.url}`);
```

## License

MIT
