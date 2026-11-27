import type { ForgeHttpApp } from '@forge-fr/http';
import type { AnySchema } from '@forge-fr/validation';

export interface OpenApiSchemaObject {
  readonly type?: string | readonly string[];
  readonly format?: string;
  readonly description?: string;
  readonly enum?: readonly unknown[];
  readonly const?: unknown;
  readonly default?: unknown;
  readonly nullable?: boolean;
  readonly properties?: Readonly<Record<string, OpenApiSchemaObject>>;
  readonly required?: readonly string[];
  readonly additionalProperties?: boolean | OpenApiSchemaObject;
  readonly items?: OpenApiSchemaObject;
  readonly prefixItems?: readonly OpenApiSchemaObject[];
  readonly anyOf?: readonly OpenApiSchemaObject[];
  readonly oneOf?: readonly OpenApiSchemaObject[];
  readonly allOf?: readonly OpenApiSchemaObject[];
  readonly minimum?: number;
  readonly maximum?: number;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly pattern?: string;
  readonly [key: string]: unknown;
}

export interface OpenApiParameter {
  readonly name: string;
  readonly in: 'path' | 'query' | 'header' | 'cookie';
  readonly required: boolean;
  readonly description?: string;
  readonly schema: OpenApiSchemaObject;
}

export interface OpenApiMediaType {
  readonly schema?: OpenApiSchemaObject;
}

export interface OpenApiRequestBody {
  readonly required?: boolean;
  readonly description?: string;
  readonly content: Readonly<Record<string, OpenApiMediaType>>;
}

export interface OpenApiResponse {
  readonly description: string;
  readonly content?: Readonly<Record<string, OpenApiMediaType>>;
}

export interface OpenApiSecurityScheme {
  readonly type: 'apiKey' | 'http' | 'oauth2' | 'openIdConnect';
  readonly description?: string;
  readonly name?: string;
  readonly in?: 'query' | 'header' | 'cookie';
  readonly scheme?: string;
  readonly bearerFormat?: string;
  readonly openIdConnectUrl?: string;
}

export interface OpenApiOperation {
  readonly operationId?: string;
  readonly summary?: string;
  readonly description?: string;
  readonly tags?: readonly string[];
  readonly deprecated?: boolean;
  readonly security?: readonly Readonly<Record<string, readonly string[]>>[];
  readonly parameters?: readonly OpenApiParameter[];
  readonly requestBody?: OpenApiRequestBody;
  readonly responses: Readonly<Record<string, OpenApiResponse>>;
}

export type OpenApiPathMethod = 'get' | 'post' | 'put' | 'patch' | 'delete' | 'options' | 'head';

export type OpenApiPathItem = Partial<Record<OpenApiPathMethod, OpenApiOperation>>;

export interface OpenApiServer {
  readonly url: string;
  readonly description?: string;
}

export interface OpenApiTag {
  readonly name: string;
  readonly description?: string;
}

export interface OpenApiInfo {
  readonly title: string;
  readonly version: string;
  readonly description?: string;
}

export interface OpenApiComponents {
  readonly schemas?: Readonly<Record<string, OpenApiSchemaObject>>;
  readonly securitySchemes?: Readonly<Record<string, OpenApiSecurityScheme>>;
}

export interface OpenApiDocument {
  readonly openapi: '3.1.0';
  readonly info: OpenApiInfo;
  readonly servers?: readonly OpenApiServer[];
  readonly tags?: readonly OpenApiTag[];
  readonly paths: Readonly<Record<string, OpenApiPathItem>>;
  readonly components?: OpenApiComponents;
  readonly security?: readonly Readonly<Record<string, readonly string[]>>[];
}

export interface OpenApiRouteDoc {
  readonly operationId?: string;
  readonly summary?: string;
  readonly description?: string;
  readonly tags?: readonly string[];
  readonly deprecated?: boolean;
  readonly security?: readonly Readonly<Record<string, readonly string[]>>[];
  readonly exclude?: boolean;
  readonly responses?: Readonly<
    Record<
      string,
      {
        readonly description: string;
        readonly schema?: AnySchema | OpenApiSchemaObject;
      }
    >
  >;
}

export interface OpenApiGeneratorOptions {
  readonly title: string;
  readonly version: string;
  readonly description?: string;
  readonly servers?: readonly OpenApiServer[];
  readonly tags?: readonly OpenApiTag[];
  readonly securitySchemes?: Readonly<Record<string, OpenApiSecurityScheme>>;
  readonly security?: readonly Readonly<Record<string, readonly string[]>>[];
  readonly excludePaths?: readonly string[];
  readonly schemaConverter?: (schema: unknown) => OpenApiSchemaObject | undefined;
}

export interface SwaggerUiOptions {
  readonly title?: string;
  /** Pin CDN base URL for swagger-ui-dist. Must be https:// or relative path. */
  readonly swaggerUiDistUrl?: string;
  /** Optional persistence key override. */
  readonly persistAuthorization?: boolean;
}

export interface RegisterOpenApiRoutesOptions extends OpenApiGeneratorOptions {
  /** Spec JSON path. Default: `'/openapi.json'`. */
  readonly specPath?: string;
  /** Swagger UI HTML path. Default: `'/docs'`. */
  readonly docsPath?: string;
  /** Optional guard predicate or disable flag for production environments. Default: `true`. */
  readonly enabled?: boolean;
  /** Swagger UI rendering options. */
  readonly ui?: SwaggerUiOptions;
}

export interface OpenApiPluginOptions extends RegisterOpenApiRoutesOptions {
  readonly app?: ForgeHttpApp;
  readonly registerRoutes?: boolean;
  readonly registerHealthCheck?: boolean;
  readonly healthCheckName?: string;
}
