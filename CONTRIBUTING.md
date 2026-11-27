# Contributing to ForgeJS (`@forge-fr/*`)

Thank you for contributing to ForgeJS! Every package in this repository follows strict pure-ESM TypeScript, minimal-dependency boundaries, and OWASP ASVS 5.0.0 security defaults.

*(Looking for Indonesian documentation? See [`docs/id/quick-start.md`](./docs/id/quick-start.md) and [`docs/id/architecture.md`](./docs/id/architecture.md).)*

---

## 1. Local Development Setup

**Prerequisites:**
- **Node.js** `>=22.18.0` (see [`.nvmrc`](./.nvmrc))
- **npm** `>=10.x` (or **Bun** `>=1.4.0` for cross-runtime parity checks)

```bash
git clone https://github.com/forge-fr/forgejs.git
cd forgejs
npm install
npm run build
```

### Verification Commands

| Command | Purpose |
| :--- | :--- |
| `npm run build` | Compile all 20 `@forge-fr/*` packages in strict project-reference topological order |
| `npm run typecheck` | Typecheck all 20 packages with `tsc -b --noEmit` |
| `npm run packages:verify` | Verify tarball hygiene, clean `NodeNext`/`Bundler` imports, and CLI binary smoke tests |
| `npm run docs:verify` | Typecheck and execute all verified `ts forge-example` snippets |
| `npm run bench` | Run the reproducible benchmark suite against Hono and Fastify |

---

## 2. Architectural & Coding Standards

1. **Pure ESM Only:** All relative imports inside `packages/*/src/` must include explicit `.js` extensions compatible with `NodeNext` module resolution.
2. **Strict TypeScript:** All packages compile with `strict: true`, `exactOptionalPropertyTypes: true`, `noUncheckedIndexedAccess: true`, and `verbatimModuleSyntax: true`.
3. **Minimal Dependencies:** `@forge-fr/core` and `@forge-fr/router` must remain **zero third-party runtime dependencies**.
4. **No Cross-Runtime Leaks:** Keep `node:*` APIs isolated to `@forge-fr/node`, `@forge-fr/cli`, and `@forge-fr/storage` local drivers, `Bun.*` APIs isolated to `@forge-fr/bun`, and keep `@forge-fr/edge` strictly WinterCG Fetch-standard.
5. **Security by Default:** Never strip input/output sanitization, header-injection checks, prototype-pollution guards, or `ForgeError.expose = false` 5xx behavior. Read [`SECURITY.md`](./SECURITY.md) before modifying security-sensitive modules.

---

## 3. Submitting Changes

1. Open or reference an existing [GitHub Issue](https://github.com/forge-fr/forgejs/issues/new/choose) for non-trivial changes.
2. Create a focused branch from `main`.
3. Use clear commit messages following Conventional Commits:
   - `feat(http): ...`
   - `fix(auth): ...`
   - `docs: ...`
   - `perf(router): ...`
4. Verify your changes pass `npm run build`, `npm run typecheck`, `npm run packages:verify`, and `npm run docs:verify`.
5. Fill out the Pull Request template checklist cleanly.

For documentation previews and interactive backend testing, visit [https://forgejs.dev](https://forgejs.dev).

---

## 4. Code of Conduct

All contributors and maintainers agree to follow our [`CODE_OF_CONDUCT.md`](./CODE_OF_CONDUCT.md).
