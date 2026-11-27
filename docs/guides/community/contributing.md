# Contributing

> Monorepo workspace layout, strict TypeScript standards, architectural boundary tests, and verification commands for contributors.

- **Section**: Community & Contributing
- **Packages**: @forge-fr/core
- **Version**: v1.0.0-rc.1
- **Updated**: 2026-11-26
- **HTML URL**: https://github.com/forge-fr/forgejs/docs/community/contributing
- **Markdown URL**: https://github.com/forge-fr/forgejs/docs/community/contributing.md
- **Source**: https://github.com/forge-fr/forgejs/blob/main/README.md

## Repository standards & boundary rules

- Strict TypeScript: strict: true, exactOptionalPropertyTypes: true, noUncheckedIndexedAccess: true, pure ESM only.
- Zero node:* or Bun globals in core, router, http, validation, openapi, authorization, security, or edge packages.
- All 20 packages share synchronized versions and must remain acyclic in the workspace dependency graph.

## Running the full verification suite

**File: `terminal`**

```bash
npx vitest run
node scripts/verify-packaging.mjs
node scripts/verify-docs-examples.mjs
bun scripts/verify-docs-examples.mjs
```
