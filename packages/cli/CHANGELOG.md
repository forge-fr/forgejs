# Changelog

## 0.1.0 (2026-11-25)
- Initial release of `@forge-fr/cli`:
  - Cross-runtime CLI executable (`forge`) and programmatic `runCli()` runner for Node.js `v22+` and Bun `1.4+`.
  - Project scaffolding (`forge new`) with `minimal`, `api`, and `modular` TypeScript ESM starter templates.
  - Code generators (`forge generate module|controller|service`) with strict identifier & confined path validation.
  - Plugin registration (`forge plugin add`) with official `@forge-fr/*` catalog and safe `package.json` updates.
  - Cross-runtime lifecycle orchestration (`forge dev`, `forge build`, `forge start`, `forge test`) and diagnostics (`forge doctor`).
