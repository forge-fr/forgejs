export { OpenApiError } from './errors.js';

export {
  sanitizeJsonSchema,
  schemaToJsonSchema,
  type SchemaReflectOptions,
} from './reflector.js';

export {
  OPENAPI_META_KEY,
  attachOpenApiMetadata,
  getAttachedOpenApiMetadata,
  openApiMeta,
  validatedOpenApiHandler,
  type OpenApiHandlerMetadata,
} from './routes.js';

export { generateOpenApiDocument } from './generator.js';
export { registerOpenApiRoutes, renderSwaggerUiHtml } from './swagger.js';
export { OpenApiTokens, createOpenApiPlugin } from './plugin.js';

export type {
  OpenApiComponents,
  OpenApiDocument,
  OpenApiGeneratorOptions,
  OpenApiInfo,
  OpenApiMediaType,
  OpenApiOperation,
  OpenApiParameter,
  OpenApiPathItem,
  OpenApiPathMethod,
  OpenApiPluginOptions,
  OpenApiRequestBody,
  OpenApiResponse,
  OpenApiRouteDoc,
  OpenApiSchemaObject,
  OpenApiSecurityScheme,
  OpenApiServer,
  OpenApiTag,
  RegisterOpenApiRoutesOptions,
  SwaggerUiOptions,
} from './types.js';
