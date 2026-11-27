# Prisma ORM

> Integrate generated PrismaClient (v5/v6/v7+) with P1xxx/P2xxx error normalization and kernel $disconnect draining.

- **Section**: Database & Data Access
- **Packages**: @forge-fr/prisma, @forge-fr/database
- **Version**: v1.0.0-rc.1
- **Updated**: 2026-11-26
- **HTML URL**: https://github.com/forge-fr/forgejs/docs/database/prisma
- **Markdown URL**: https://github.com/forge-fr/forgejs/docs/database/prisma.md
- **Source**: https://github.com/forge-fr/forgejs/blob/main/docs/data-and-auth.md

## Registering PrismaClient with the kernel

@forge-fr/prisma accepts any duck-typed PrismaClientLike instance (supporting Prisma v5, v6, and v7+ driver adapters) without pinning @prisma/client as a hard runtime dependency.

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

## Prisma P1xxx/P2xxx error mapping

| Prisma Error Code | Mapped ForgeJS Database Error |
| --- | --- |
| P2002 | DatabaseUniqueViolationError |
| P2003 | DatabaseForeignKeyError |
| P2034 | DatabaseSerializationError |
| P1001 / P1002 / P1008 | DatabaseConnectionError / DatabaseTimeoutError |
