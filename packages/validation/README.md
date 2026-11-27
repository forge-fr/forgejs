# @forge-fr/validation

Standard Schema v1 validation engine for **ForgeJS**, supporting Zod v4, Valibot v1, ArkType, legacy Zod v3 (`safeParseAsync`), and custom validators with full TypeScript inference and zero lock-in.

## Features

- Native `@standard-schema/spec` v1 core (`validate`, `validateOrThrow`, `createSchemaValidator`, `isStandardSchema`).
- Zero-runtime-coupling adapters (`zodAdapter`, `valibotAdapter`, `fromStandardSchema`, `customSchema`) with optional peer dependencies.
- Route-level HTTP validation (`validatedHandler` and `validateRequest` + `getValidated`) for `params`, `query`, `headers`, `body`, and `response`.
- Security-first defaults: bounded body parsing (`413`), prototype-pollution key stripping, excess-field response stripping, and non-exposed `ResponseValidationError` (`500`) on response contract failures.

## Usage

```ts
import { createHttpApp } from '@forge-fr/http';
import { validatedHandler } from '@forge-fr/validation';
import { z } from 'zod';

const app = createHttpApp();

app.post(
  '/users',
  validatedHandler(
    {
      body: z.object({ email: z.string().email(), name: z.string().min(2) }),
      response: z.object({ id: z.string(), email: z.string() }),
    },
    (ctx, { body }) => ctx.status(201).json({ id: 'u_1', email: body.email }),
  ),
);
```

## License

MIT
