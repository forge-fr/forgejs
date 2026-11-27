# @forge-fr/http

Web Standards HTTP engine for **ForgeJS**, built on standard `Request`, `Response`, `Headers`, `URL`, `ReadableStream`, and `AbortSignal` with zero Node.js or Bun runtime-specific imports.

## Features

- **`createHttpApp()`** unifying `@forge-fr/core` (7-stage kernel, DI, modules) and `@forge-fr/router` (radix-tree matching, groups, RFC 405 `Allow`).
- **`ForgeContext`** with lazy request-scoped DI (`ctx.resolve()`), null-prototype `params` and `query`, correlation `requestId`, child `logger`, and ergonomic response builders (`json`, `text`, `html`, `bytes`, `empty`, `redirect`, `stream`, `sse`).
- **Deterministic Tiered Middleware:** `global → module → group → route` sorted by ascending numeric priority with registration-order tie-breaking, double-`next()` detection (`ForgeMiddlewareError`), and post-commit mutation protection (`ResponseCommittedError`).
- **7 HTTP Lifecycle Hooks:** `onRequest`, `preValidation`, `preHandler`, `preSerialization`, `onSend`, `onError`, and `onResponse`.
- **Bounded Body & Multipart Parsing:** Streaming byte enforcement (`413 PayloadTooLargeError`), prototype-pollution key stripping for JSON/forms, and strict field/file/size limits for `multipart/form-data`.
- **Content Negotiation & SSE:** RFC 9110 `Accept` quality/specificity negotiation (`ctx.accepts()`) and CRLF-safe Server-Sent Events (`ctx.sse()`).

## Usage

```ts
import { createHttpApp } from '@forge-fr/http';

const app = createHttpApp();

app.get('/users/:id', (ctx) => {
  return ctx.json({ id: ctx.params.id });
});

await app.start();
const response = await app.fetch(new Request('http://localhost/users/42'));
```

## License

MIT
