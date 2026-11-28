# Introduction

> What ForgeJS is, how it stays simple and portable across runtimes, and how it compares with Express, Fastify, Hono, and NestJS.

- **Section**: Getting Started
- **Packages**: @forge-fr/core, @forge-fr/http
- **Version**: v1.0.0
- **Updated**: 2026-11-27
- **HTML URL**: https://github.com/forge-fr/forgejs/docs/getting-started/introduction
- **Markdown URL**: https://github.com/forge-fr/forgejs/docs/getting-started/introduction.md
- **Source**: https://github.com/forge-fr/forgejs/blob/main/docs/quick-start.md

## What is ForgeJS?

ForgeJS is an open-source TypeScript backend framework built on standard web APIs (Request, Response, Headers, Streams, and Web Crypto) using modern JavaScript modules (ESM).

Instead of locking your business logic to one server runtime or relying on complex class decorators, ForgeJS separates your app code from the server layer across 21 focused @forge-fr/* packages synchronized at v1.0.0.

- 16 of the 21 packages have zero third-party runtime dependencies, keeping installs small and predictable.
- Tested locally on Node.js v22.23.5 and Bun 1.4.4, plus an edge runtime adapter (@forge-fr/edge) for Cloudflare Workers and Deno.
- 63 automated boundary checks verify that core framework packages never accidentally import Node-only or Bun-only APIs.

## Design philosophy & framework comparison

ForgeJS favors clear, explicit wiring over hidden framework magic. You pass typed service tokens (createToken<T>()), group features into modules (defineModule()), and extend the app with permission-checked plugins (definePlugin()) while keeping startup and request speed fast.

| Area | ForgeJS Approach | Trade-off to Keep in Mind |
| --- | --- | --- |
| Modules & Wiring | Plain typed tokens & defineModule() functions | No class decorators or reflect-metadata needed |
| Runtime Portability | Standard Web API core + small Node, Bun, and Edge adapters | Modern ESM only (Node.js >= 22.18.0; no CommonJS require) |
| Security Posture | Safe HTTP defaults + ready-to-use OWASP ASVS 5.0.0 security middleware | Your app services still decide who owns each record |
| Database Support | Official PostgreSQL, Drizzle, and Prisma plugins with UnitOfWork | TypeORM, MikroORM, Sequelize, and Knex are not built-in |

## When ForgeJS might not be the right fit

- Your project still depends on CommonJS require() or runs on Node.js older than 22.18.0.
- Your team specifically wants decorator-based class controllers (like NestJS) or built-in TypeORM/MikroORM.
- You only need a tiny single-file router and do not want lifecycle management, modules, or built-in security helpers.
