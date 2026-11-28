# Changelog

## 0.1.0 — 2026-11-25

- Initial release of `@forge-fr/http` (Milestone 2.2):
  - `createHttpApp()` integrating `@forge-fr/core` ApplicationKernel and `@forge-fr/router`.
  - `HttpRuntimeAdapter` contract (`ListenOptions`, `ServerAddress`, `RuntimeRequestMeta`, `FetchHandler`).
  - `ForgeContext` with lazy request-scoped DI, CRLF header validation, post-commit response guard, and response helpers (`json`, `text`, `html`, `bytes`, `empty`, `redirect`, `stream`, `sse`).
  - Deterministic middleware engine (`global → module → group → route`) with double-`next()` detection (`NEXT_ALREADY_CALLED`).
  - Bounded streaming body/JSON/URL-encoded/multipart parsers, RFC 9110 `Accept` negotiation, and SSE streaming.

## [1.0.0] - 2026-11-27

### Added & Changed
- Added symbol-backed `createContextKey<T>()` (`ctx.set/get/has/require`), streaming `ctx.body.multipartStream()`, magic-byte MIME checks, `ctx.formData()`, `ctx.binary()`, RFC 6266 `ctx.download()`, and the `@forge-fr/http/realtime` (`createRealtimeHub`, `createMemoryPubSubAdapter`, SSE `extractLastEventId`) subpath.

