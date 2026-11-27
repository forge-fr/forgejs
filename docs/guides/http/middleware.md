# Middleware & Hooks

> Deterministic tiered middleware (global → module → group → route), double-next() guards, and 7 HTTP lifecycle hooks.

- **Section**: HTTP & API Development
- **Packages**: @forge-fr/http
- **Version**: v1.0.0-rc.1
- **Updated**: 2026-11-26
- **HTML URL**: https://github.com/forge-fr/forgejs/docs/http/middleware
- **Markdown URL**: https://github.com/forge-fr/forgejs/docs/http/middleware.md
- **Source**: https://github.com/forge-fr/forgejs/blob/main/docs/http-and-validation.md

## Tiered ordering & safety guards

- Middleware executes deterministically by tier: global → module → group → route, ordered by numeric priority within each tier.
- Calling next() twice throws ForgeMiddlewareError; mutating headers after commit throws ResponseCommittedError.
- Compiled pipelines are cached directly on each route object (route._pipelineRun) for zero-allocation hot-path dispatch.

## Seven HTTP lifecycle hooks

| Hook | Execution Point | Typical Use Case |
| --- | --- | --- |
| onRequest | Before route matching | Request metrics, custom tracing span start |
| preValidation | After route match, before schema validation | Header normalization or tenant extraction |
| preHandler | After validation, before route handler | Route-level authorization checks |
| preSerialization | After handler returns payload, before JSON stringify | Envelope formatting or field auditing |
| onSend | Before final Response leaves app.fetch() | Appending custom response headers |
| onError | When any middleware or handler throws | Structured error logging with ctx.requestId |
| onResponse | After response is finalized | Latency histograms and access logs |
