# @forge-fr/prisma

> Prisma ORM adapter supporting Prisma v5/v6/v7+ generated clients, P1xxx/P2xxx error normalization, isolation-level transactions, and $disconnect draining.

- **Version**: v1.0.0-rc.2
- **Layer**: Adapter Layer
- **Category**: database
- **Tarball**: 9.1 kB (16 files)
- **Internal deps**: @forge-fr/core, @forge-fr/database
- **Runtime deps**: zero runtime dependencies
- **Peer deps**: @prisma/client >=5 || >=6 || >=7 (optional)
- **HTML URL**: https://github.com/forge-fr/forgejs/api/prisma
- **Markdown URL**: https://github.com/forge-fr/forgejs/api/prisma.md

## Installation

```bash
npm install @forge-fr/prisma
```

## Plugin Metadata

- **Factory**: `createPrismaPlugin`
- **Tokens**: `DefaultPrismaTokens`
- **Health probe**: `prisma`
- **Capabilities**: `di:register`, `health:register`

## Runtime & Error Semantics

- **Runtime**: Zero third-party runtime dependencies; optional peer @prisma/client >=5 || >=6 || >=7. Preserves generated PrismaClient typing.
- **Errors**: normalizePrismaError maps P1xxx connection errors and P2xxx constraint violations to typed ForgeJS database errors.

## Usage Example

```ts
import { createPrismaPlugin, DefaultPrismaTokens } from '@forge-fr/prisma';
import { createKernel } from '@forge-fr/core';
import { PrismaClient } from '@prisma/client';

const kernel = createKernel({
  plugins: [[createPrismaPlugin(), { client: new PrismaClient() }]],
});
await kernel.start();
const prisma = kernel.container.resolve(DefaultPrismaTokens.client);
```

## Public Exports

### Prisma ORM Adapter & Plugin

- **Values**: `DefaultPrismaTokens`, `createPrismaToken`, `createPrismaAdapter`, `createPrismaPlugin`, `prismaConfigSchema`, `normalizePrismaError`
- **Types**: `PrismaAdapterOptions`, `PrismaClientLike`, `PrismaIsolationLevel`, `PrismaPluginOptions`, `PrismaTokens`, `PrismaTransactionOptions`
