# OpenAPI 3.1 & Swagger UI

> Generate OpenAPI 3.1 specs straight from your route schemas and serve a hardened Swagger UI page automatically.

- **Section**: HTTP & API Development
- **Packages**: @forge-fr/openapi, @forge-fr/validation
- **Version**: v1.0.0
- **Updated**: 2026-11-27
- **HTML URL**: https://github.com/forge-fr/forgejs/docs/http/openapi
- **Markdown URL**: https://github.com/forge-fr/forgejs/docs/http/openapi.md
- **Source**: https://github.com/forge-fr/forgejs/blob/main/docs/http-and-validation.md

## Auto-generated OpenAPI 3.1 specs & Swagger UI

validatedOpenApiHandler(schemas, handler, metadata) validates requests at runtime while recording OpenAPI metadata. Call registerOpenApiRoutes(app, { title, version }) to expose /openapi.json and a safe /docs Swagger UI page.

**File: `src/openapi.ts`**

```ts
import { createHttpApp } from '@forge-fr/http';
import {
  generateOpenApiDocument,
  registerOpenApiRoutes,
  validatedOpenApiHandler,
} from '@forge-fr/openapi';
import { z } from 'zod';

const app = createHttpApp();

app.get(
  '/items/:id',
  validatedOpenApiHandler(
    {
      params: z.object({ id: z.string() }),
      response: z.object({ id: z.string(), name: z.string() }),
    },
    (_ctx, input) => ({ id: input.params.id, name: 'Widget' }),
    { operationId: 'getItem', summary: 'Fetch item by ID', tags: ['Items'] },
  ),
);

registerOpenApiRoutes(app, {
  title: 'Forge Store API',
  version: '1.0.0',
});

const spec = generateOpenApiDocument(app, { title: 'Forge Store API', version: '1.0.0' });
```

## Swagger UI safety notes

> **SECURITY: XSS Protection & Public Production APIs**
>
> renderSwaggerUiHtml() escapes titles and URLs and sets strict Content-Security-Policy headers. For private APIs, protect /docs behind authentication or turn it off in public production.
