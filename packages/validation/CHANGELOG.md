# Changelog

## 0.1.0 — 2026-11-25

- Initial release of `@forge-fr/validation` (Milestone 2.4):
  - Standard Schema v1 validation engine (`validate`, `validateOrThrow`, `createSchemaValidator`, `formatStandardIssues`, `ResponseValidationError`).
  - Zero-runtime-coupling adapters for Zod v4/v3 (`zodAdapter`), Valibot v1 (`valibotAdapter`), Standard Schema (`fromStandardSchema`), and custom validators (`customSchema`).
  - HTTP route validation (`validatedHandler`, `validateRequest`, `getValidated`) for `params`, `query`, `headers`, `body`, and `response`.

## [1.0.0] - 2026-11-27

### Added & Changed
- Attached validation schemas automatically in `validatedHandler()` via `Symbol.for("forgejs.validation.schemas")` for unified OpenAPI 3.1 auto-discovery.

