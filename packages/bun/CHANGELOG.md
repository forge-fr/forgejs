# Changelog

## 0.1.0 — 2026-11-25

- Initial release of `@forge-fr/bun` (Milestone 2.3):
  - Native `Bun.serve()` `BunAdapter` and `createBunAdapter()` implementing `HttpRuntimeAdapter`.
  - `server.requestIP()` mapping, `maxRequestBodySize`, `idleTimeout`, `AbortSignal` shutdown, graceful `server.stop(false)` draining, and explicit `BUN_RUNTIME_REQUIRED` guard.
