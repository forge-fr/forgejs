# Request & Response

> Compact 13-field ForgeContext, bounded body readers (1 MiB default), RFC 9110 Accept negotiation, streaming, compression, and ETags.

- **Section**: HTTP & API Development
- **Packages**: @forge-fr/http
- **Version**: v1.0.0-rc.1
- **Updated**: 2026-11-26
- **HTML URL**: https://github.com/forge-fr/forgejs/docs/http/request-and-response
- **Markdown URL**: https://github.com/forge-fr/forgejs/docs/http/request-and-response.md
- **Source**: https://github.com/forge-fr/forgejs/blob/main/docs/http-and-validation.md

## Bounded body readers & response helpers

- readBoundedJson, readBoundedText, readBoundedBytes, readBoundedUrlEncoded, and readBoundedMultipart enforce DEFAULT_MAX_BODY_BYTES (1 MiB) even when Content-Length is omitted or chunked.
- Oversized payloads abort streaming immediately and return 413 PayloadTooLargeError.
- ctx.json(), ctx.text(), ctx.html(), ctx.bytes(), ctx.empty(), and ctx.redirect() construct fast Web Standard responses.
- ctx.requestId is generated lazily on read or error (or preserved from incoming headers only when trustRequestId: true).

## Web Standards compression & conditional ETag middleware

createCompressionMiddleware() uses native CompressionStream (gzip/deflate) with bounded byte caps, while createEtagMiddleware() computes SHA-256 ETags and serves 304 Not Modified responses.

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
