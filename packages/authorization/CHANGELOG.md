# Changelog

## 0.1.0 - 2026-11-25

- Initial release of `@forge-fr/authorization` (Phase 4 — Milestone 4.4).
- Added RBAC registry with cycle detection, segment-strict permissions, and deny-overrides-allow precedence.
- Added async policy engine with fail-closed evaluation and decision audit hooks.
- Added resource ownership (anti-IDOR) and multi-tenant isolation guards usable at both service and HTTP route boundaries.
- Added HTTP route middleware guards (`requireRoles`, `requirePermissions`, `requireTenantParam`, `createAuthorizationMiddleware`) and `createAuthorizationPlugin()`.

## [1.0.0] - 2026-11-27

### Added & Changed
- Synchronized `@forge-fr/authorization` to `1.0.0` General Availability with typed `AuthIdentityKey` integration.

