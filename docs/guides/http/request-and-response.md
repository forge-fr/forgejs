# Request & Response

> Safe size-limited body readers (1 MiB default), clean response helpers, built-in gzip/deflate compression, and ETag caching.

- **Section**: HTTP & API Development
- **Packages**: @forge-fr/http
- **Version**: v1.0.0
- **Updated**: 2026-11-27
- **HTML URL**: https://github.com/forge-fr/forgejs/docs/http/request-and-response
- **Markdown URL**: https://github.com/forge-fr/forgejs/docs/http/request-and-response.md
- **Source**: https://github.com/forge-fr/forgejs/blob/main/docs/http-and-validation.md

## Size-limited body readers & response helpers

- Built-in body readers (JSON, text, bytes, form URL-encoded, and multipart) enforce a 1 MiB default limit even when clients omit Content-Length.
- Requests larger than the limit stop streaming right away and return HTTP 413 Payload Too Large.
- Use ctx.json(), ctx.text(), ctx.html(), ctx.bytes(), ctx.empty(), and ctx.redirect() to build clean responses quickly.
- ctx.requestId is generated on demand when read or on errors (incoming ID headers are ignored unless trustRequestId: true).

## Built-in compression & ETag 304 caching

createCompressionMiddleware() compresses responses with standard Web CompressionStream (gzip or deflate) under safe size caps. createEtagMiddleware() generates SHA-256 ETags and returns 304 Not Modified when content has not changed.

**File: `src/http.ts`**

```ts
import {
  createCompressionMiddleware,
  createEtagMiddleware,
  createHttpApp,
} from '@forge-fr/http';

const app = createHttpApp();
app.use(createCompressionMiddleware({ thresholdBytes: 64, maxBytes: 1_048_576 }));
app.use(createEtagMiddleware());

app.get('/catalog', (ctx) =>
  ctx.json({ items: ['core', 'http', 'edge'], generatedAt: new Date().toISOString() }),
);
```
