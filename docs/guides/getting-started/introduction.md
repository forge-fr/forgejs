# Introduction

> What ForgeJS is, its architectural philosophy, honest comparisons with Express, Fastify, Hono, and NestJS, and verified runtime targets.

- **Section**: Getting Started
- **Packages**: @forge-fr/core, @forge-fr/http
- **Version**: v1.0.0-rc.1
- **Updated**: 2026-11-26
- **HTML URL**: https://github.com/forge-fr/forgejs/docs/getting-started/introduction
- **Markdown URL**: https://github.com/forge-fr/forgejs/docs/getting-started/introduction.md
- **Source**: https://github.com/forge-fr/forgejs/blob/main/docs/quick-start.md

## What is ForgeJS?

ForgeJS is an open-source, pure-ESM, strict-TypeScript backend framework built directly on Web Standards (Request, Response, Headers, ReadableStream, AbortSignal, CompressionStream, and Web Crypto).

Rather than coupling application logic to node:http primitives or requiring runtime reflection decorators, ForgeJS separates domain code from host runtimes across 20 modular @forge-fr/* packages synchronized at v1.0.0-rc.1.

- 16 of 20 packages ship with zero third-party runtime dependencies.
- Verified locally on Node.js v22.23.5 and Bun 1.4.4, with a zero-global WinterCG Edge adapter (@forge-fr/edge).
- 60/60 automated architectural boundary assertions enforce unidirectional layering across the workspace.

## Design philosophy & framework comparison

ForgeJS favors explicit composition over hidden magic: typed tokens (createToken<T>()), encapsulated modules (defineModule()), and capability-scoped plugins (definePlugin()) deliver predictable structure without sacrificing cold-start latency or request throughput.

| Dimension | ForgeJS Approach | Trade-off to Consider |
| --- | --- | --- |
| DI & Modules | Composition-first typed tokens & defineModule() | No reflect-metadata or class decorator magic |
| Runtime Portability | Web Standards core + thin Node/Bun/Edge adapters | Pure ESM only (Node.js >=22.18.0; no legacy CJS) |
| Security Posture | Hardened HTTP defaults + composable OWASP ASVS 5.0.0 suite | App services still own authorization & domain policies |
| Database Strategy | Native PostgreSQL, Drizzle, and Prisma plugins | TypeORM, MikroORM, Sequelize, and Knex are not built-in |

## When not to use ForgeJS

- If your codebase requires CommonJS require() output or Node.js versions older than 22.18.0.
- If you specifically want decorator-driven NestJS class controllers or built-in TypeORM/MikroORM integration.
- If you only need a single-file micro-router with zero lifecycle, DI, or security primitives.
