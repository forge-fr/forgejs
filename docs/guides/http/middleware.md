# Middleware & Hooks

> Predictable middleware ordering (global → module → group → route), double-next protection, and 7 HTTP lifecycle hooks.

- **Section**: HTTP & API Development
- **Packages**: @forge-fr/http
- **Version**: v1.0.0
- **Updated**: 2026-11-27
- **HTML URL**: https://github.com/forge-fr/forgejs/docs/http/middleware
- **Markdown URL**: https://github.com/forge-fr/forgejs/docs/http/middleware.md
- **Source**: https://github.com/forge-fr/forgejs/blob/main/docs/http-and-validation.md

## Predictable execution order & safety guards

- Middleware always runs in a clear order: global → module → group → route (with optional numeric priority inside each level).
- Calling next() twice throws ForgeMiddlewareError, and trying to change headers after a response is sent throws ResponseCommittedError.
- ForgeJS compiles and caches each route pipeline once, avoiding extra per-request overhead.

## Seven HTTP lifecycle hooks

| Hook | When It Runs | Common Use Case |
| --- | --- | --- |
| onRequest | Before route matching | Start request timers or tracing spans |
| preValidation | After route match, before schema checks | Normalize headers or extract tenant ID |
| preHandler | After validation, before your handler | Check route permissions or roles |
| preSerialization | After your handler returns data, before JSON encoding | Wrap response payloads or audit fields |
| onSend | Right before the final Response is returned | Attach custom response headers |
| onError | Whenever a middleware or handler throws | Log structured errors with ctx.requestId |
| onResponse | After the response is finished | Record access logs and latency metrics |
