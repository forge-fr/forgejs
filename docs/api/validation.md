# @forge-fr/validation

> Standard Schema v1 validation engine with Zod v4 direct fast path, typed route handler wrapper, response schema stripping, and recursive prototype-pollution sanitization.

- **Version**: v1.0.0-rc.1
- **Layer**: Adapter Layer
- **Category**: validation
- **Tarball**: 13.6 kB (24 files)
- **Internal deps**: @forge-fr/core, @forge-fr/http
- **Runtime deps**: @standard-schema/spec ^1.1.0
- **Peer deps**: zod >=3.24 || >=4 (optional), valibot >=1 (optional)
- **HTML URL**: https://github.com/forge-fr/forgejs/api/validation
- **Markdown URL**: https://github.com/forge-fr/forgejs/api/validation.md

## Installation

```bash
npm install @forge-fr/validation
```

## Runtime & Error Semantics

- **Runtime**: Built on @standard-schema/spec v1 with a direct Zod v4 safeParse fast path and automatic Standard Schema fallback.
- **Errors**: Invalid request inputs throw ValidationError (400). Invalid outgoing responses throw ResponseValidationError (500, expose: false) to prevent accidental PII leakage.

## Usage Example

```ts
import { createHttpApp } from '@forge-fr/http';
import { validatedHandler } from '@forge-fr/validation';
import { z } from 'zod';

const app = createHttpApp();
app.post(
  '/items',
  validatedHandler(
    {
      body: z.object({ name: z.string().min(2) }),
      response: z.object({ ok: z.literal(true), name: z.string() }),
    },
    (ctx, input) => ctx.json({ ok: true, name: input.body.name }),
  ),
);
```

## Public Exports

### Validation Engine & Schema Adapters

- **Values**: `validate`, `validateOrThrow`, `createSchemaValidator`, `formatStandardIssues`, `isStandardSchema`, `ResponseValidationError`, `zodAdapter`, `valibotAdapter`, `customSchema`, `fromStandardSchema`
- **Types**: `AnySchema`, `CustomValidateFn`, `InferInput`, `InferOutput`, `LegacySafeParseIssue`, `LegacyZodLikeSchema`, `SchemaValidator`, `StandardSchemaV1`, `ValidateOptions`, `ValidationFailure`, `ValidationIssue`, `ValidationResult`, `ValidationSuccess`

### HTTP Validation Helpers

- **Values**: `validatedHandler`, `validateRequest`, `getValidated`, `VALIDATED_STATE_KEY`
- **Types**: `HttpValidationOptions`, `RouteValidationSchemas`, `ValidatedInput`, `ValidatedRouteHandler`, `ValidationTarget`
