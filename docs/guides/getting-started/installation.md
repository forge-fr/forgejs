# Installation

> System requirements, public npm and GitHub Packages setup, install commands for pnpm, npm, and Bun, TypeScript config, and quick fixes.

- **Section**: Getting Started
- **Packages**: @forge-fr/core, @forge-fr/http, @forge-fr/node, @forge-fr/bun, @forge-fr/cli
- **Version**: v1.0.0
- **Updated**: 2026-11-27
- **HTML URL**: https://github.com/forge-fr/forgejs/docs/getting-started/installation
- **Markdown URL**: https://github.com/forge-fr/forgejs/docs/getting-started/installation.md
- **Source**: https://github.com/forge-fr/forgejs/blob/main/docs/quick-start.md

## Runtime & TypeScript requirements

- Node.js >= 22.18.0 (tested on v22.23.5) OR Bun >= 1.4.0 (tested on 1.4.4).
- Modern ESM enabled in your project ("type": "module" in package.json).
- TypeScript 5.8+ or 7.x with strict: true and moduleResolution set to "NodeNext" or "Bundler".

> **TIP: Installing @forge-fr/* from npm or GitHub Packages**
>
> All 21 @forge-fr/* packages (v1.0.0) are published under the @forge-fr/* scope for public npm (registry.npmjs.org) and mirrored on GitHub Packages (npm.pkg.github.com).

## Install packages or scaffold with CLI

Install the core HTTP engine, a runtime adapter (@forge-fr/node, @forge-fr/bun, or @forge-fr/edge), and validation directly from npm (or configure @forge-fr:registry=https://npm.pkg.github.com in .npmrc for GitHub Packages) — or generate a starter project with @forge-fr/cli.

**pnpm (`terminal`)**

```bash
# 1. Add GitHub Packages registry to .npmrc
echo "@forge-fr:registry=https://npm.pkg.github.com" >> .npmrc

# 2. Install packages
pnpm add @forge-fr/core @forge-fr/http @forge-fr/node @forge-fr/validation zod

# Or create a new project with @forge-fr/cli
pnpm dlx @forge-fr/cli@latest new my-api --template modular --runtime node
```

**npm (`terminal`)**

```bash
# 1. Add GitHub Packages registry to .npmrc
echo "@forge-fr:registry=https://npm.pkg.github.com" >> .npmrc

# 2. Install packages
npm install @forge-fr/core @forge-fr/http @forge-fr/node @forge-fr/validation zod

# Or create a new project with @forge-fr/cli
npx @forge-fr/cli@latest new my-api --template modular --runtime node
```

**bun (`terminal`)**

```bash
# 1. Add GitHub Packages registry to .npmrc
echo "@forge-fr:registry=https://npm.pkg.github.com" >> .npmrc

# 2. Install packages
bun add @forge-fr/core @forge-fr/http @forge-fr/bun @forge-fr/validation zod

# Or create a new project with @forge-fr/cli
bunx @forge-fr/cli@latest new my-api --template modular --runtime bun
```

## Recommended tsconfig.json & health check

Run forge doctor inside your project folder to check that your Node.js version (>= 22), optional Bun binary, "type": "module" setting, and strict TypeScript options are ready.

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

## Common setup issues and quick fixes

| Problem | Why it happens | How to fix it |
| --- | --- | --- |
| 404 / 401 when installing @forge-fr/* | Missing GitHub Packages registry or token in .npmrc | Add @forge-fr:registry=https://npm.pkg.github.com and a read:packages token to .npmrc |
| ERR_REQUIRE_ESM | Using CommonJS require() with an ESM @forge-fr/* package | Set "type": "module" in package.json and use import statements |
| TS2307 module not found | Local relative imports missing .js extension in NodeNext mode | Use .js in local imports (for example, import "./app.js") |
| forge doctor fails on node-version | Running Node.js 18 or 20 | Upgrade to Node.js >= 22.18.0 or use Bun >= 1.4.0 |
