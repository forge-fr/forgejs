# Error Handling

> Structured ForgeError hierarchy, production expose: false sanitization, normalizeError(), and HTTP onError hooks.

- **Section**: Core Concepts
- **Packages**: @forge-fr/core, @forge-fr/http
- **Version**: v1.0.0-rc.1
- **Updated**: 2026-11-26
- **HTML URL**: https://github.com/forge-fr/forgejs/docs/concepts/error-handling
- **Markdown URL**: https://github.com/forge-fr/forgejs/docs/concepts/error-handling.md
- **Source**: https://github.com/forge-fr/forgejs/blob/main/docs/architecture.md

## Built-in ForgeError subclasses

| Class | HTTP Status | Default expose | Typical Cause |
| --- | --- | --- | --- |
| ValidationError | 400 | true (sanitized issues) | Standard Schema validation failure on params/query/headers/body |
| UnauthorizedError | 401 | true | Missing, expired, or invalid credentials |
| ForbiddenError | 403 | true | Authenticated actor lacks role, policy, ownership, or tenant access |
| NotFoundError | 404 | true | Domain entity or route resource does not exist |
| ConflictError | 409 | true | Unique constraint or state conflict |
| ConfigurationError | 500 (boot) | false | Invalid environment or plugin schema at startup |
| InternalError | 500 | false | Unexpected runtime exception wrapped by normalizeError() |

## Fail-closed production error serialization

Unknown thrown errors are wrapped with normalizeError() into InternalError with expose: false. In production, HTTP responses emit only a generic message, code, and requestId — never stack traces or database URLs.

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
