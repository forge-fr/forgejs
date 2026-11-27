# Integrating External Libraries

> Use optional peerDependencies and duck-typed interfaces (RedisClientLike, PrismaClientLike) to keep core packages dependency-free.

- **Section**: Plugins & Extensions
- **Packages**: @forge-fr/core, @forge-fr/cache, @forge-fr/prisma
- **Version**: v1.0.0-rc.1
- **Updated**: 2026-11-26
- **HTML URL**: https://github.com/forge-fr/forgejs/docs/plugins/external-libraries
- **Markdown URL**: https://github.com/forge-fr/forgejs/docs/plugins/external-libraries.md
- **Source**: https://github.com/forge-fr/forgejs/blob/main/PACKAGE_STRATEGY.md

## Duck-typed peer integration pattern

Packages like @forge-fr/cache, @forge-fr/queue, @forge-fr/prisma, and @forge-fr/auth accept narrow structural interfaces (RedisClientLike, PrismaClientLike, BetterAuthLike) so applications can upgrade peer clients cleanly without version-pin lock-in.

| Package | Structural Interface / Peer Strategy |
| --- | --- |
| @forge-fr/cache & @forge-fr/queue | RedisClientLike — works with ioredis or node-redis wrappers without hard runtime coupling |
| @forge-fr/prisma | PrismaClientLike — supports Prisma v5, v6, and v7+ generated clients |
| @forge-fr/validation | @standard-schema/spec v1 — Zod v4, Valibot v1, ArkType, plus zodAdapter for Zod v3 |
| @forge-fr/auth | Optional peer @node-rs/argon2 on Node.js; native Bun.password on Bun |
