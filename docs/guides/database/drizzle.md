# Drizzle ORM

> Use Drizzle ORM with full native TypeScript schema inference via createDrizzlePostgresPlugin() and automatic pool cleanup.

- **Section**: Database & Data Access
- **Packages**: @forge-fr/drizzle, @forge-fr/database
- **Version**: v1.0.0
- **Updated**: 2026-11-27
- **HTML URL**: https://github.com/forge-fr/forgejs/docs/database/drizzle
- **Markdown URL**: https://github.com/forge-fr/forgejs/docs/database/drizzle.md
- **Source**: https://github.com/forge-fr/forgejs/blob/main/docs/data-and-auth.md

## Full native Drizzle TypeScript inference

Pass your schema type to createDrizzlePostgresPlugin<typeof schema>() to use Drizzle query builders and db.query.* directly with zero wrapper friction.

**File: `src/db/drizzle.ts`**

```ts
import { createKernel, secret } from '@forge-fr/core';
import {
  createDrizzlePostgresPlugin,
  DefaultDrizzleTokens,
} from '@forge-fr/drizzle';
import * as schema from './schema.js';

const kernel = createKernel({
  plugins: [
    [
      createDrizzlePostgresPlugin<typeof schema>(),
      {
        url: secret(process.env.DATABASE_URL ?? ''),
        schema,
      },
    ],
  ],
});

await kernel.start();
const db = kernel.container.resolve(DefaultDrizzleTokens.db);
```

## Transactions & clean shutdown

- Supports safe transactions with allowlisted isolation levels and wraps errors through normalizeDrizzleError().
- Closes the underlying postgres-js pool automatically when kernel.shutdown() runs.
