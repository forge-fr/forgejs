# Architecture

> Unidirectional 6-layer architecture enforced by 60 automated boundary checks across all 20 @forge-fr/* workspace packages.

- **Section**: Core Concepts
- **Packages**: @forge-fr/core, @forge-fr/router, @forge-fr/http
- **Version**: v1.0.0-rc.2
- **Updated**: 2026-11-26
- **HTML URL**: https://github.com/forge-fr/forgejs/docs/concepts/architecture
- **Markdown URL**: https://github.com/forge-fr/forgejs/docs/concepts/architecture.md
- **Source**: https://github.com/forge-fr/forgejs/blob/main/docs/architecture.md

## Six unidirectional layers

ForgeJS isolates domain services from host runtimes and third-party drivers. Dependencies always point inward toward Web Standards and @forge-fr/core contracts.

| Layer | Packages | Boundary Rule |
| --- | --- | --- |
| Application | User controllers + @forge-fr/http + @forge-fr/validation | Translates HTTP/WS inputs into typed domain calls |
| Domain | User defineModule() services + @forge-fr/authorization | Zero node:* or Bun globals; depends only on DI tokens |
| Infrastructure | database, drizzle, prisma, auth, security, logger, cache, queue, storage | Registers providers via capability-scoped PluginContext |
| Framework Core | @forge-fr/core, @forge-fr/router, @forge-fr/http | Zero third-party runtime dependencies; Web Standards only |
| Runtime Adapters | @forge-fr/node, @forge-fr/bun, @forge-fr/edge, @forge-fr/testing | Implements HttpRuntimeAdapter contract & graceful drain |

## Automated boundary enforcement

tests/architecture/boundaries.test.ts runs 60 assertions across all 20 packages verifying zero forbidden runtime globals (node:*, Bun, process) in core/router/http/edge packages, strict acyclic package DAGs, and pure-ESM exports.

> **NOTE: Why zero node:* imports in @forge-fr/core matters**
>
> Keeping @forge-fr/core, @forge-fr/router, @forge-fr/http, and @forge-fr/validation strictly on Web Standards allows identical domain code and middleware to run on Node.js 22, Bun 1.4, and WinterCG Edge workers without polyfill shims.
