# `@forge-fr/config`

Typed configuration and environment validation for ForgeJS using **Standard Schema v1** (Zod, Valibot, ArkType, and custom schemas).

- Runtime-agnostic root entry (`@forge-fr/config`) with zero `node:*` imports (works on Node.js, Bun, Cloudflare Workers, and Deno)
- Optional `@forge-fr/config/node` subpath for `.env` / `.env.<NODE_ENV>` file loading on Node.js and Bun
- Deeply frozen immutable validated output and secret-safe startup validation errors
- First-class ForgeJS DI plugin (`createConfigPlugin` & `createConfigToken`)

## Installation

```bash
npm install @forge-fr/config @forge-fr/core zod
```

## Quick Usage

```ts
import { defineConfig } from '@forge-fr/config';
import { z } from 'zod';

const config = defineConfig({
  schema: z.object({
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    DATABASE_URL: z.string().url(),
    JWT_SECRET: z.string().min(32),
  }),
});

console.log(config.PORT);
```
