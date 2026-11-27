# Changelog

## 0.1.0 - 2026-11-25

- Initial release of `@forge-fr/security` (Phase 5 — Milestone 5.1).
- Added hardened HTTP security headers middleware and CSP builder covering both normal and error responses.
- Added strict CORS middleware with startup hard-error on wildcard `*` + `credentials: true`.
- Added CSRF synchronizer/double-submit & `Origin`/`Sec-Fetch-Site` middleware with constant-time comparison.
- Added pluggable rate limiting middleware with bounded in-memory store and trusted-proxy-safe client IP extraction.
- Added prototype pollution sanitizer, canonical path confinement, safe filename normalizer, hardened cookie serializer, and SSRF-safe outbound fetch guard.
- Added ForgeJS DI plugin (`createSecurityPlugin`, `SecurityTokens`).
