# Validation

> Standard Schema v1 validation across params, query, headers, and body with Zod v4 fast path and prototype-pollution sanitization.

- **Section**: HTTP & API Development
- **Packages**: @forge-fr/validation
- **Version**: v1.0.0-rc.2
- **Updated**: 2026-11-26
- **HTML URL**: https://github.com/forge-fr/forgejs/docs/http/validation
- **Markdown URL**: https://github.com/forge-fr/forgejs/docs/http/validation.md
- **Source**: https://github.com/forge-fr/forgejs/blob/main/docs/http-and-validation.md

## Zod v4, Valibot v1 & Standard Schema v1

@forge-fr/validation supports any @standard-schema/spec v1 schema natively (Zod v4, Valibot v1, ArkType) plus zodAdapter for legacy Zod v3 and customSchema() for bespoke validators. Incoming JSON bodies are scanned to strip __proto__, constructor, and prototype keys automatically.

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

## Compiled Zod v4 fast path

compileFastValidator() detects synchronous Zod v4 schemas once at route registration and invokes safeParse() directly (2.6x faster than ~standard.validate), falling back automatically to Standard Schema validate() for async refinements, Valibot, or custom validators.
