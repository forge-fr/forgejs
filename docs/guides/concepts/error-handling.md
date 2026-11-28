# Error Handling

> Use built-in ForgeError classes for clear HTTP errors while automatically hiding internal details and stack traces in production.

- **Section**: Core Concepts
- **Packages**: @forge-fr/core, @forge-fr/http
- **Version**: v1.0.0
- **Updated**: 2026-11-27
- **HTML URL**: https://github.com/forge-fr/forgejs/docs/concepts/error-handling
- **Markdown URL**: https://github.com/forge-fr/forgejs/docs/concepts/error-handling.md
- **Source**: https://github.com/forge-fr/forgejs/blob/main/docs/architecture.md

## Built-in ForgeError classes

| Class | HTTP Status | Shown to Client? | Common Use Case |
| --- | --- | --- | --- |
| ValidationError | 400 | Yes (safe field issues) | Invalid params, query, headers, or JSON body |
| UnauthorizedError | 401 | Yes | Missing, expired, or invalid login credentials |
| ForbiddenError | 403 | Yes | User is logged in but lacks permission or tenant access |
| NotFoundError | 404 | Yes | Requested record or route does not exist |
| ConflictError | 409 | Yes | Duplicate value or conflicting record state |
| ConfigurationError | 500 (boot) | No | Missing or invalid environment/plugin config on startup |
| InternalError | 500 | No | Unexpected error wrapped safely by normalizeError() |

## Safe production error responses

Unexpected errors are automatically wrapped by normalizeError() into InternalError with expose: false. In production, clients receive only a generic message, error code, and requestId — never stack traces or database URLs.

**File: `src/errors.ts`**

```ts
import { NotFoundError } from '@forge-fr/core';
import { createHttpApp } from '@forge-fr/http';

const app = createHttpApp({ exposeErrorDetails: false });

app.addHook('onError', ({ error, ctx }) => {
  ctx.logger?.error('Request failed', { requestId: ctx.requestId, code: error.code });
});

app.get('/orders/:id', (ctx) => {
  throw new NotFoundError(`Order ${ctx.params.id} not found`);
});
```
