# Changelog

## 0.1.0 — 2026-11-25

- Phase 3 — Milestone 3.2:
  - Added `createPluginTestHarness()` for isolated plugin testing with dependency wiring, Standard Schema config validation, strict `resolveExport()` verification, and `health()` checks.
- Phase 2 — Milestone 2.3:
  - Added shared 8-case `runHttpAdapterContractSuite()` for dual-runtime HTTP adapter verification.
- Initial release of `@forge-fr/testing` (Milestone 2.2):
  - `MemoryAdapter` conforming to `HttpRuntimeAdapter`.
  - `createTestClient()` ergonomic in-process HTTP test client.
  - `overrideProvider()` DI provider override helper.

## [1.0.0] - 2026-11-27

### Added & Changed
- Added `createTestKernel()` and `createTestApp()` with typed DI token overrides, `overrideValue()`, `Symbol.asyncDispose`, and `TestClient` multipart, SSE (`getSse()`), and cookie-jar (`withCookies()`) helpers.

