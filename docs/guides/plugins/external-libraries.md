# Integrating External Libraries

> How ForgeJS integrates Redis, Prisma, Zod, and Argon2 via optional peer dependencies without locking your versions.

- **Section**: Plugins & Extensions
- **Packages**: @forge-fr/core, @forge-fr/cache, @forge-fr/prisma
- **Version**: v1.0.0
- **Updated**: 2026-11-27
- **HTML URL**: https://github.com/forge-fr/forgejs/docs/plugins/external-libraries
- **Markdown URL**: https://github.com/forge-fr/forgejs/docs/plugins/external-libraries.md
- **Source**: https://github.com/forge-fr/forgejs/blob/main/PACKAGE_STRATEGY.md

## Flexible peer integration pattern

Packages like @forge-fr/cache, @forge-fr/queue, @forge-fr/prisma, and @forge-fr/auth accept small structural interfaces (like RedisClientLike or PrismaClientLike). That means you can upgrade your Redis or Prisma client without waiting for a framework release.

| Package | Client Interface / Peer Strategy |
| --- | --- |
| @forge-fr/cache & @forge-fr/queue | RedisClientLike — works with ioredis or custom Redis wrappers without hard coupling |
| @forge-fr/prisma | PrismaClientLike — supports Prisma v5, v6, and v7+ generated clients |
| @forge-fr/validation | Standard Schema v1 — Zod v4, Valibot v1, ArkType, plus zodAdapter for Zod v3 |
| @forge-fr/auth | Optional @node-rs/argon2 on Node.js; built-in Bun.password on Bun |
