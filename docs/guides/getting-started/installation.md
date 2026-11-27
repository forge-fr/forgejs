# Installation

> Runtime prerequisites, package manager commands for pnpm, npm, and Bun, CLI scaffolding, TypeScript settings, and troubleshooting.

- **Section**: Getting Started
- **Packages**: @forge-fr/core, @forge-fr/http, @forge-fr/node, @forge-fr/bun, @forge-fr/cli
- **Version**: v1.0.0-rc.1
- **Updated**: 2026-11-26
- **HTML URL**: https://github.com/forge-fr/forgejs/docs/getting-started/installation
- **Markdown URL**: https://github.com/forge-fr/forgejs/docs/getting-started/installation.md
- **Source**: https://github.com/forge-fr/forgejs/blob/main/docs/quick-start.md

## Runtime & TypeScript prerequisites

- Node.js >= 22.18.0 (verified locally on v22.23.5) OR Bun >= 1.4.0 (verified locally on 1.4.4).
- Pure ESM package configuration ("type": "module" in package.json).
- TypeScript 5.8+ / 7.x with strict: true and moduleResolution: "NodeNext" or "Bundler".

> **WARNING: v1.0.0-rc.1 Pre-Publication Status**
>
> All 20 @forge-fr/* packages are verified locally via npm pack tarballs and isolated consumer smoke tests. Live publication to registry.npmjs.org under the @next tag awaits maintainer execution of .github/workflows/release.yml.

## Install core packages or scaffold with CLI

Install the HTTP core, a runtime adapter (@forge-fr/node, @forge-fr/bun, or @forge-fr/edge), and Standard Schema validation, or scaffold a complete ESM TypeScript project with @forge-fr/cli.

**pnpm (`terminal`)**

```bash
pnpm add @forge-fr/core @forge-fr/http @forge-fr/node @forge-fr/validation zod

# Scaffold a modular project with @forge-fr/cli
pnpm dlx @forge-fr/cli@next new my-api --template modular --runtime node
```

**npm (`terminal`)**

```bash
npm install @forge-fr/core @forge-fr/http @forge-fr/node @forge-fr/validation zod

# Scaffold a modular project with @forge-fr/cli
npx @forge-fr/cli@next new my-api --template modular --runtime node
```

**bun (`terminal`)**

```bash
bun add @forge-fr/core @forge-fr/http @forge-fr/bun @forge-fr/validation zod

# Scaffold a modular project with @forge-fr/cli
bunx @forge-fr/cli@next new my-api --template modular --runtime bun
```

## Recommended tsconfig.json & environment doctor

Run forge doctor inside your project directory to verify Node.js >=22, optional Bun availability, "type": "module", and strict TypeScript configuration.

**File: `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "exactOptionalPropertyTypes": true,
    "noUncheckedIndexedAccess": true,
    "skipLibCheck": true
  }
}
```

## Common installation pitfalls

| Symptom | Cause | Resolution |
| --- | --- | --- |
| ERR_REQUIRE_ESM | Attempting to require() a @forge-fr/* package from CommonJS | Add "type": "module" to package.json and use ES import syntax |
| TS2307 module not found | Relative imports missing .js extension under NodeNext | Import local TypeScript modules with .js specifiers (e.g. ./app.js) |
| doctor FAIL on node-version | Running Node.js 18 or 20 | Upgrade to Node.js >= 22.18.0 or use Bun >= 1.4.0 |
