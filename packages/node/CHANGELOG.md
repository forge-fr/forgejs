# Changelog

## 0.1.0 — 2026-11-25

- Initial release of `@forge-fr/node` (Milestone 2.3):
  - Native `node:http` `NodeAdapter` and `createNodeAdapter()` implementing `HttpRuntimeAdapter`.
  - Backpressure-safe Web Streams translation, multi-value `Set-Cookie`, client abort propagation, adapter-level `maxBodyBytes`, sanitized `Host` resolution, `AbortSignal` shutdown, and graceful connection draining.
