# @forge-fr/prisma

> Official Prisma ORM adapter for Prisma v5, v6, and v7+ clients with createPrismaUnitOfWork, consistent error mapping, safe transactions, and clean shutdown.

- **Version**: v1.0.0
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
# Add once to .npmrc: @forge-fr:registry=https://npm.pkg.github.com
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
