# Validation

> Validate params, query, headers, and JSON bodies with Zod v4, Valibot v1, or any Standard Schema v1 library.

- **Section**: HTTP & API Development
- **Packages**: @forge-fr/validation
- **Version**: v1.0.0
- **Updated**: 2026-11-27
- **HTML URL**: https://github.com/forge-fr/forgejs/docs/http/validation
- **Markdown URL**: https://github.com/forge-fr/forgejs/docs/http/validation.md
- **Source**: https://github.com/forge-fr/forgejs/blob/main/docs/http-and-validation.md

## Works with Zod v4, Valibot v1, and Standard Schema

@forge-fr/validation works out of the box with any Standard Schema v1 library (Zod v4, Valibot v1, ArkType), plus zodAdapter for Zod v3 and customSchema() for custom validators. Incoming JSON is also stripped of __proto__, constructor, and prototype keys automatically.

**File: `src/validated-route.ts`**

```ts
import { createHttpApp } from '@forge-fr/http';
import { validatedHandler } from '@forge-fr/validation';
import * as v from 'valibot';
import { z } from 'zod';

const app = createHttpApp();

app.post(
  '/projects/:projectId/tasks',
  validatedHandler(
    {
      params: z.object({ projectId: z.string().min(2) }),
      query: v.object({ dryRun: v.optional(v.string()) }),
      body: z.object({ title: z.string().min(3) }),
    },
    (ctx, input) =>
      ctx.json(
        {
          projectId: input.params.projectId,
          dryRun: input.query.dryRun === 'true',
          title: input.body.title,
        },
        { status: 201 },
      ),
  ),
);
```

## Fast path for synchronous Zod v4 schemas

At route setup, compileFastValidator() checks if your schema is a synchronous Zod v4 schema and calls safeParse() directly for extra speed. For async rules, Valibot, or custom schemas, it falls back automatically to the standard validate() interface.
