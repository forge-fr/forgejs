# @forge-fr/drizzle

> Official Drizzle ORM plugin with createDrizzleUnitOfWork that preserves 100% of Drizzle TypeScript inference, adds typed transactions, and maps PostgreSQL errors cleanly.

- **Version**: v1.0.0
- **Layer**: Adapter Layer
- **Category**: database
- **Tarball**: 8.6 kB (16 files)
- **Internal deps**: @forge-fr/core, @forge-fr/database
- **Runtime deps**: zero runtime dependencies
- **Peer deps**: drizzle-orm >=0.40.0 <1.0.0
- **HTML URL**: https://github.com/forge-fr/forgejs/api/drizzle
- **Markdown URL**: https://github.com/forge-fr/forgejs/api/drizzle.md

## Installation

```bash
# Add once to .npmrc: @forge-fr:registry=https://npm.pkg.github.com
npm install @forge-fr/drizzle
```

## Plugin Metadata

- **Factory**: `createDrizzlePostgresPlugin`
- **Tokens**: `DefaultDrizzleTokens`
- **Health probe**: `drizzle`
- **Capabilities**: `di:register`, `health:register`

## Runtime & Error Semantics

- **Runtime**: Zero third-party runtime dependencies; peer depends on drizzle-orm >=0.40.0 <1.0.0. Preserves 100% native PostgresJsDatabase<TSchema> inference.
- **Errors**: normalizeDrizzleError unwraps DrizzleQueryError causes so SQLSTATE violations map cleanly to ForgeJS DatabaseError classes.

## Usage Example

```ts
import { createDrizzlePostgresPlugin, DefaultDrizzleTokens } from '@forge-fr/drizzle';
import { createKernel, secret } from '@forge-fr/core';
import * as schema from './schema.js';

const kernel = createKernel({
  plugins: [
    [createDrizzlePostgresPlugin<typeof schema>(), { url: secret(process.env.DATABASE_URL ?? ''), schema }],
  ],
});
await kernel.start();
const db = kernel.container.resolve(DefaultDrizzleTokens.db);
```

## Public Exports

### Drizzle ORM Adapter & Plugin

- **Values**: `DefaultDrizzleTokens`, `createDrizzleToken`, `createDrizzleAdapter`, `createDrizzlePostgresAdapter`, `createDrizzlePostgresPlugin`, `drizzlePostgresConfigSchema`, `normalizeDrizzleError`
- **Types**: `DrizzleCasing`, `DrizzlePostgresAdapter`, `DrizzlePostgresClient`, `DrizzlePostgresConfig`, `DrizzlePostgresPluginOptions`, `DrizzlePostgresTx`, `DrizzleTokens`, `GenericDrizzleAdapterOptions`, `InferDrizzleTx`
