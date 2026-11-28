# Contributing

> How the monorepo is organized, coding and boundary rules, and how to run the full test and doc checks before a PR.

- **Section**: Community & Contributing
- **Packages**: @forge-fr/core
- **Version**: v1.0.0
- **Updated**: 2026-11-27
- **HTML URL**: https://github.com/forge-fr/forgejs/docs/community/contributing
- **Markdown URL**: https://github.com/forge-fr/forgejs/docs/community/contributing.md
- **Source**: https://github.com/forge-fr/forgejs/blob/main/README.md

## Repository standards & boundary rules

- Strict TypeScript (strict, exactOptionalPropertyTypes, noUncheckedIndexedAccess) and pure ESM across every package.
- No node:* or Bun globals inside core, router, http, validation, openapi, authorization, security, or edge.
- All 20 packages stay on matching versions with zero circular package dependencies.

## Run the full verification suite

**File: `terminal`**

```bash
npx vitest run
node scripts/verify-packaging.mjs
node scripts/verify-docs-examples.mjs
bun scripts/verify-docs-examples.mjs
```
