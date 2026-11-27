# Response Validation & Serialization

> Enforce outgoing response contracts with validatedHandler({ response }) to strip accidental PII before serialization.

- **Section**: HTTP & API Development
- **Packages**: @forge-fr/validation, @forge-fr/http
- **Version**: v1.0.0-rc.1
- **Updated**: 2026-11-26
- **HTML URL**: https://github.com/forge-fr/forgejs/docs/http/serialization
- **Markdown URL**: https://github.com/forge-fr/forgejs/docs/http/serialization.md
- **Source**: https://github.com/forge-fr/forgejs/blob/main/docs/http-and-validation.md

## Fail-closed response schemas

Passing a response schema to validatedHandler() validates and strips outgoing payloads before serialization. Contract violations throw ResponseValidationError (HTTP 500, expose: false) so internal schema defects are logged privately rather than leaked.

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
