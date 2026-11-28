# Changelog — @forge-fr/drizzle

## 0.1.0 (2026-11-25)

- Initial release of `@forge-fr/drizzle` (Phase 4 — Milestone 4.2).
- Added `createDrizzleToken`, `DefaultDrizzleTokens`, `normalizeDrizzleError`, `drizzlePostgresConfigSchema`, `createDrizzlePostgresAdapter`, `createDrizzlePostgresPlugin`, and generic `createDrizzleAdapter`.

## [1.0.0] - 2026-11-27

### Added & Changed
- Added `createDrizzleUnitOfWork()` and `DefaultDrizzleTokens.UnitOfWork` preserving native Drizzle query builders and `.afterCommit()` / `.afterRollback()` hooks.

