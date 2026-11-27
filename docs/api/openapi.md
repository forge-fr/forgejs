# @forge-fr/openapi

> OpenAPI 3.1 generator reflecting Standard Schema v1 routes into JSON Schema 2020-12 with validatedOpenApiHandler and XSS-escaped Swagger UI routes.

- **Version**: v1.0.0-rc.1
- **Layer**: Adapter Layer
- **Category**: validation
- **Tarball**: 17.5 kB (36 files)
- **Internal deps**: @forge-fr/core, @forge-fr/http, @forge-fr/validation
- **Runtime deps**: zero runtime dependencies
- **Peer deps**: none
- **HTML URL**: https://github.com/forge-fr/forgejs/api/openapi
- **Markdown URL**: https://github.com/forge-fr/forgejs/api/openapi.md

## Installation

```bash
npm install @forge-fr/openapi
```

## Plugin Metadata

- **Factory**: `createOpenApiPlugin`
- **Tokens**: `OpenApiTokens`
- **Health probe**: `openapi`
- **Capabilities**: `di:register`, `health:register`

## Runtime & Error Semantics

- **Runtime**: Zero third-party runtime dependencies. Reflects Standard Schema v1 routes into JSON Schema 2020-12 OpenAPI 3.1 documents.
- **Errors**: Swagger UI HTML output is XSS-escaped and served with strict Content-Security-Policy headers.

## Usage Example

```ts
import { createHttpApp } from '@forge-fr/http';
import { registerOpenApiRoutes } from '@forge-fr/openapi';

const app = createHttpApp();
registerOpenApiRoutes(app, {
  title: 'Billing API',
  version: '1.0.0',
});
```

## Public Exports

### OpenAPI 3.1 Generator, Swagger UI & Plugin

- **Values**: `OpenApiError`, `sanitizeJsonSchema`, `schemaToJsonSchema`, `OPENAPI_META_KEY`, `attachOpenApiMetadata`, `getAttachedOpenApiMetadata`, `openApiMeta`, `validatedOpenApiHandler`, `generateOpenApiDocument`, `registerOpenApiRoutes`, `renderSwaggerUiHtml`, `OpenApiTokens`, `createOpenApiPlugin`
- **Types**: `OpenApiComponents`, `OpenApiDocument`, `OpenApiGeneratorOptions`, `OpenApiHandlerMetadata`, `OpenApiInfo`, `OpenApiMediaType`, `OpenApiOperation`, `OpenApiParameter`, `OpenApiPathItem`, `OpenApiPathMethod`, `OpenApiPluginOptions`, `OpenApiRequestBody`, `OpenApiResponse`, `OpenApiRouteDoc`, `OpenApiSchemaObject`, `OpenApiSecurityScheme`, `OpenApiServer`, `OpenApiTag`, `RegisterOpenApiRoutesOptions`, `SchemaReflectOptions`, `SwaggerUiOptions`
