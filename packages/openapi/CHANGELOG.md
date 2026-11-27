# `@forge-fr/openapi`

## `0.1.0`

- Initial release:
  - OpenAPI 3.1.0 document generator from `@forge-fr/http` / `@forge-fr/router` routes & metadata (`generateOpenApiDocument`).
  - Zero-dependency JSON Schema 2020-12 reflector (`schemaToJsonSchema`) supporting Zod v4, Valibot v1, custom converters, and direct JSON Schema objects with prototype-pollution stripping & recursion depth limits.
  - Typed route attachment helpers (`validatedOpenApiHandler`, `openApiMeta`) preserving strict TypeScript inference.
  - Hardened Swagger UI endpoint (`registerOpenApiRoutes`, `renderSwaggerUiHtml`) with strict HTML/JS escaping and Content-Security-Policy headers.
  - ForgeJS DI plugin (`createOpenApiPlugin`, `OpenApiTokens`).
