# OpenAPI 3.1 & Swagger UI

> Reflect Standard Schema routes into JSON Schema 2020-12 OpenAPI 3.1 documents and mount XSS-escaped Swagger UI with strict CSP.

- **Section**: HTTP & API Development
- **Packages**: @forge-fr/openapi, @forge-fr/validation
- **Version**: v1.0.0-rc.1
- **Updated**: 2026-11-26
- **HTML URL**: https://github.com/forge-fr/forgejs/docs/http/openapi
- **Markdown URL**: https://github.com/forge-fr/forgejs/docs/http/openapi.md
- **Source**: https://github.com/forge-fr/forgejs/blob/main/docs/http-and-validation.md

## Generating OpenAPI 3.1 specs & hardened Swagger UI

validatedOpenApiHandler(schemas, handler, metadata) attaches typed OpenAPI metadata while enforcing runtime validation. registerOpenApiRoutes(app, { title, version }) serves /openapi.json and an XSS-escaped /docs Swagger UI page with strict Content-Security-Policy headers.

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

## Swagger UI security posture

> **SECURITY: XSS Escaping & Production Visibility**
>
> renderSwaggerUiHtml() escapes spec titles and URLs and sets object-src 'none' CSP headers. Consider gating /docs behind authentication or disabling Swagger UI in public internet deployments.
