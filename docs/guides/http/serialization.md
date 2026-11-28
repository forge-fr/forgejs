# Response Validation & Serialization

> Check outgoing response data with validatedHandler({ response }) so sensitive fields never slip into API output.

- **Section**: HTTP & API Development
- **Packages**: @forge-fr/validation, @forge-fr/http
- **Version**: v1.0.0
- **Updated**: 2026-11-27
- **HTML URL**: https://github.com/forge-fr/forgejs/docs/http/serialization
- **Markdown URL**: https://github.com/forge-fr/forgejs/docs/http/serialization.md
- **Source**: https://github.com/forge-fr/forgejs/blob/main/docs/http-and-validation.md

## Safe outgoing response schemas

Adding a response schema to validatedHandler() validates and cleans outgoing objects before turning them into JSON. If your handler returns data that breaks the schema, ForgeJS throws ResponseValidationError (HTTP 500, hidden from clients) so bugs are caught in logs without leaking internal data.

**File: `src/response-contract.ts`**

```ts
import { createHttpApp } from '@forge-fr/http';
import { validatedHandler } from '@forge-fr/validation';
import { z } from 'zod';

const PublicUserSchema = z.object({
  id: z.string(),
  displayName: z.string(),
});

const app = createHttpApp();

app.get(
  '/users/:id',
  validatedHandler(
    {
      params: z.object({ id: z.string() }),
      response: PublicUserSchema,
    },
    (_ctx, input) => ({
      id: input.params.id,
      displayName: 'Ada Lovelace',
      // passwordHash is stripped automatically by PublicUserSchema
      passwordHash: '$argon2id$...',
    }),
  ),
);
```
