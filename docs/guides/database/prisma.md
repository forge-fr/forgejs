# Prisma ORM

> Connect PrismaClient (v5, v6, or v7+) to the ForgeJS kernel with clean error mapping and automatic $disconnect on shutdown.

- **Section**: Database & Data Access
- **Packages**: @forge-fr/prisma, @forge-fr/database
- **Version**: v1.0.0
- **Updated**: 2026-11-27
- **HTML URL**: https://github.com/forge-fr/forgejs/docs/database/prisma
- **Markdown URL**: https://github.com/forge-fr/forgejs/docs/database/prisma.md
- **Source**: https://github.com/forge-fr/forgejs/blob/main/docs/data-and-auth.md

## Register PrismaClient with the kernel

@forge-fr/prisma accepts any generated PrismaClient instance (Prisma v5, v6, or v7+ driver adapters) through a lightweight structural interface, so you can upgrade Prisma independently.

**File: `src/db/prisma.ts`**

```ts
import { createKernel } from '@forge-fr/core';
import { createPrismaPlugin, DefaultPrismaTokens } from '@forge-fr/prisma';
import { PrismaClient } from '@prisma/client';

const kernel = createKernel({
  plugins: [
    [createPrismaPlugin(), { client: new PrismaClient() }],
  ],
});

await kernel.start();
const prisma = kernel.container.resolve(DefaultPrismaTokens.client);
```

## Mapped Prisma error codes

| Prisma Error Code | ForgeJS Database Error |
| --- | --- |
| P2002 | DatabaseUniqueViolationError |
| P2003 | DatabaseForeignKeyError |
| P2034 | DatabaseSerializationError |
| P1001 / P1002 / P1008 | DatabaseConnectionError / DatabaseTimeoutError |
