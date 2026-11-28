# Architecture

> How ForgeJS organizes code into 6 clear layers enforced by 60 automated boundary checks across all 20 packages.

- **Section**: Core Concepts
- **Packages**: @forge-fr/core, @forge-fr/router, @forge-fr/http
- **Version**: v1.0.0
- **Updated**: 2026-11-27
- **HTML URL**: https://github.com/forge-fr/forgejs/docs/concepts/architecture
- **Markdown URL**: https://github.com/forge-fr/forgejs/docs/concepts/architecture.md
- **Source**: https://github.com/forge-fr/forgejs/blob/main/docs/architecture.md

## Six clear layers that depend in one direction

ForgeJS keeps your business logic separate from server runtimes and database drivers. Outer layers depend on inner contracts, never the other way around.

| Layer | Packages | Role & Boundary Rule |
| --- | --- | --- |
| Application | Your controllers + @forge-fr/http + @forge-fr/validation | Turns HTTP and WebSocket requests into typed calls to your services |
| Domain | Your defineModule() services + @forge-fr/authorization | Pure business logic; never imports Node or Bun globals |
| Infrastructure | database, drizzle, prisma, auth, security, logger, cache, queue, storage | Connects external tools through permission-checked plugins |
| Framework Core | @forge-fr/core, @forge-fr/router, @forge-fr/http | Zero third-party dependencies; built only on standard Web APIs |
| Runtime Adapters | @forge-fr/node, @forge-fr/bun, @forge-fr/edge, @forge-fr/testing | Connects the app to Node.js, Bun, Edge workers, or in-memory tests |

## Automated boundary checks

The test suite runs 60 automated checks across all 20 packages to confirm there are no forbidden runtime globals (like node:* or Bun) in core packages, no circular package dependencies, and valid ESM exports.

> **NOTE: Why keeping @forge-fr/core runtime-free matters**
>
> Because @forge-fr/core, @forge-fr/router, @forge-fr/http, and @forge-fr/validation rely strictly on Web Standards, your exact same app logic and middleware run on Node.js 22, Bun 1.4, and Cloudflare Workers without extra polyfills.
