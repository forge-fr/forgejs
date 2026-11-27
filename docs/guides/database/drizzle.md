# Drizzle ORM

> Preserve 100% native Drizzle schema and relational query inference with createDrizzlePostgresPlugin() and normalizeDrizzleError().

- **Section**: Database & Data Access
- **Packages**: @forge-fr/drizzle, @forge-fr/database
- **Version**: v1.0.0-rc.2
- **Updated**: 2026-11-26
- **HTML URL**: https://github.com/forge-fr/forgejs/docs/database/drizzle
- **Markdown URL**: https://github.com/forge-fr/forgejs/docs/database/drizzle.md
- **Source**: https://github.com/forge-fr/forgejs/blob/main/docs/data-and-auth.md

## Zero-loss Drizzle TypeScript inference

Passing your schema generic to createDrizzlePostgresPlugin<typeof schema>() preserves complete Drizzle query builder and relational db.query.* inference with zero wrapper abstractions.

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

## Transactions & error normalization

- The Drizzle adapter implements DatabaseAdapter.transaction() with allowlisted isolation levels and wraps failures through normalizeDrizzleError().
- Shutdown automatically closes the underlying postgres-js pool via LIFO kernel teardown.
