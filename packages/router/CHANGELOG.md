# Changelog — @forge-fr/router

## [0.1.0] — Milestone 2.1 (2026-11-25)

### Added
- Standalone radix-tree HTTP router (`createRouter`) with zero runtime dependencies and zero Node/Bun-specific imports.
- Support for `GET`, `POST`, `PUT`, `PATCH`, `DELETE`, `OPTIONS`, `HEAD`, `all()`, and configurable `autoHead` fallback.
- Static, constrained parameter (`:id{\d+}` / predicate constraints), dynamic parameter (`:id`), and wildcard tail (`*path`) matching with backtracking and deterministic precedence.
- Nested route groups (`group()`) composing prefixes, route-level middleware chains, and route metadata.
- Discriminated `match()` results (`found`, `method_not_allowed` with RFC `allowHeader`, `not_found`) and `routes()` introspection.
- Security protections: null-prototype `params`, forbidden `__proto__`/`constructor`/`prototype` param names, safe percent-decoding, and duplicate route rejection (`RouterError`).
