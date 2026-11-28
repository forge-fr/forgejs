# Contributing to ForgeJS (`@forge-fr/*`)

Thank you for helping improve ForgeJS! Every package in this repository uses modern ESM TypeScript, minimal dependencies, clear runtime boundaries, and safe OWASP ASVS 5.0.0 defaults.

*(Looking for Indonesian guides? See [`docs/id/quick-start.md`](./docs/id/quick-start.md) and [`docs/id/architecture.md`](./docs/id/architecture.md).)*

---

## 1. Local Development Setup

**Prerequisites:**
- **Node.js** `>=22.18.0` (see [`.nvmrc`](./.nvmrc))
- **npm** `>=10.x` (or **Bun** `>=1.4.0` for cross-runtime checks)

```bash
git clone https://github.com/forge-fr/forgejs.git
cd forgejs
npm install
npm run build
```

### Verification Commands

| Command | What It Checks |
| :--- | :--- |
| `npm run build` | Builds all 21 `@forge-fr/*` packages in dependency order |
| `npm run typecheck` | Runs strict TypeScript checks across all 21 packages |
| `npm run packages:verify` | Verifies package tarballs, ESM imports, and CLI smoke tests |
| `npm run docs:verify` | Type-checks and runs every `ts forge-example` doc snippet |
| `npm run bench` | Runs the reproducible benchmark suite against Hono and Fastify |

---

## 2. Coding & Architecture Rules

1. **Modern ESM Only:** Relative imports inside `packages/*/src/` must use `.js` extensions for `NodeNext` resolution.
2. **Strict TypeScript:** Keep `strict`, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, and `verbatimModuleSyntax` passing with zero errors.
3. **Zero Extra Core Dependencies:** `@forge-fr/core` and `@forge-fr/router` must stay free of third-party runtime dependencies.
4. **Clean Runtime Boundaries:** Keep `node:*` APIs inside `@forge-fr/node`, `@forge-fr/cli`, and local `@forge-fr/storage`; keep `Bun.*` inside `@forge-fr/bun`; keep `@forge-fr/edge` strictly on Web Fetch APIs.
5. **Safe Defaults Always On:** Never weaken input/output validation, header checks, prototype-pollution guards, or hidden 5xx errors (`ForgeError.expose = false`). Read [`SECURITY.md`](./SECURITY.md) before changing security code.

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

For documentation previews and interactive backend testing, visit [https://forgejs.id](https://forgejs.id).

---

## 4. Code of Conduct

All contributors and maintainers agree to follow our [`CODE_OF_CONDUCT.md`](./CODE_OF_CONDUCT.md).
