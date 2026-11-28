import type { ForgeHttpApp } from '@forge-fr/http';
import { schemaToJsonSchema, type SchemaReflectOptions } from './reflector.js';
import { getAttachedOpenApiMetadata } from './routes.js';
import type {
  OpenApiDocument,
  OpenApiGeneratorOptions,
  OpenApiOperation,
  OpenApiParameter,
  OpenApiPathItem,
  OpenApiPathMethod,
  OpenApiResponse,
  OpenApiSchemaObject,
} from './types.js';

function convertForgePathToOpenApi(forgePath: string): {
  readonly openApiPath: string;
  readonly pathParamNames: readonly string[];
} {
  const pathParamNames: string[] = [];
  const segments = forgePath.split('/').map((seg) => {
    if (seg.startsWith(':')) {
      const braceIdx = seg.indexOf('{');
      const name = braceIdx >= 0 ? seg.slice(1, braceIdx) : seg.slice(1);
      if (name.length > 0) {
        pathParamNames.push(name);
      }
      return `{${name}}`;
    }
    if (seg.startsWith('*')) {
      const name = seg.slice(1) || 'wildcard';
      pathParamNames.push(name);
      return `{${name}}`;
    }
    return seg;
  });
  return {
    openApiPath: segments.join('/') || '/',
    pathParamNames,
  };
}

function toOpenApiMethod(method: string): OpenApiPathMethod | undefined {
  const lower = method.toLowerCase();
  if (
    lower === 'get' ||
    lower === 'post' ||
    lower === 'put' ||
    lower === 'patch' ||
    lower === 'delete' ||
    lower === 'options' ||
    lower === 'head'
  ) {
    return lower;
  }
  return undefined;
}

function extractObjectProperties(
  schemaObj: OpenApiSchemaObject,
  inLocation: 'path' | 'query' | 'header',
): OpenApiParameter[] {
  const params: OpenApiParameter[] = [];
  const props = schemaObj.properties ?? {};
  const requiredSet = new Set(schemaObj.required ?? []);
  for (const [name, propSchema] of Object.entries(props)) {
    params.push({
      name,
      in: inLocation,
      required: inLocation === 'path' ? true : requiredSet.has(name),
      ...(propSchema.description !== undefined ? { description: propSchema.description } : {}),
      schema: propSchema,
    });
  }
  return params;
}

export function generateOpenApiDocument(
  app: ForgeHttpApp,
  options: OpenApiGeneratorOptions,
): OpenApiDocument {
  const excluded = new Set(options.excludePaths ?? []);
  const reflectOpts: SchemaReflectOptions = {
    ...(options.schemaConverter !== undefined ? { customConverter: options.schemaConverter } : {}),
  };

  const pathsMutable: Record<string, Partial<Record<OpenApiPathMethod, OpenApiOperation>>> = {};

  for (const route of app.routes()) {
    if (excluded.has(route.path)) {
      continue;
    }

    const attachment = getAttachedOpenApiMetadata(route.handler, route.meta, route.middleware);
    if (attachment?.doc?.exclude === true) {
      continue;
    }

    const methodKey = toOpenApiMethod(route.method);
    if (!methodKey) {
      continue;
    }

    const { openApiPath, pathParamNames } = convertForgePathToOpenApi(route.path);
    const schemas = attachment?.schemas;
    const doc = attachment?.doc;

    const parameters: OpenApiParameter[] = [];
    const seenParams = new Set<string>();

    if (schemas?.params) {
      const reflectedParams = schemaToJsonSchema(schemas.params, reflectOpts);
      for (const p of extractObjectProperties(reflectedParams, 'path')) {
        seenParams.add(`path:${p.name}`);
        parameters.push(p);
      }
    }

    for (const pName of pathParamNames) {
      if (!seenParams.has(`path:${pName}`)) {
        seenParams.add(`path:${pName}`);
        parameters.push({
          name: pName,
          in: 'path',
          required: true,
          schema: { type: 'string' },
        });
      }
    }

    if (schemas?.query) {
      const reflectedQuery = schemaToJsonSchema(schemas.query, reflectOpts);
      for (const p of extractObjectProperties(reflectedQuery, 'query')) {
        parameters.push(p);
      }
    }

    if (schemas?.headers) {
      const reflectedHeaders = schemaToJsonSchema(schemas.headers, reflectOpts);
      for (const p of extractObjectProperties(reflectedHeaders, 'header')) {
        parameters.push(p);
      }
    }

    const bodyContentType = doc?.requestBodyContentType ?? 'application/json';
    const requestBody =
      doc?.requestBody !== undefined
        ? doc.requestBody
        : schemas?.body
          ? {
              required: true,
              content: {
                [bodyContentType]: {
                  schema: schemaToJsonSchema(schemas.body, reflectOpts),
                },
              },
            }
          : undefined;

    const responsesMutable: Record<string, OpenApiResponse> = {};
    if (doc?.responses) {
      for (const [statusCode, spec] of Object.entries(doc.responses)) {
        const resContentType = spec.contentType ?? 'application/json';
        const content =
          spec.content !== undefined
            ? spec.content
            : spec.schema !== undefined
              ? {
                  [resContentType]: {
                    schema: schemaToJsonSchema(spec.schema, reflectOpts),
                  },
                }
              : spec.contentType !== undefined
                ? {
                    [spec.contentType]: {
                      schema: { type: 'string', format: 'binary' },
                    },
                  }
                : undefined;

        responsesMutable[statusCode] = {
          description: spec.description,
          ...(content !== undefined ? { content } : {}),
        };
      }
    }

    if (schemas?.response && responsesMutable['200'] === undefined) {
      const defaultResContentType = doc?.responseContentType ?? 'application/json';
      responsesMutable['200'] = {
        description: 'Successful response',
        content: {
          [defaultResContentType]: {
            schema: schemaToJsonSchema(schemas.response, reflectOpts),
          },
        },
      };
    }

    if (Object.keys(responsesMutable).length === 0) {
      responsesMutable['200'] = { description: 'OK' };
    }

    const operation: OpenApiOperation = {
      ...(doc?.operationId !== undefined
        ? { operationId: doc.operationId }
        : route.name !== undefined
          ? { operationId: route.name }
          : {}),
      ...(doc?.summary !== undefined ? { summary: doc.summary } : {}),
      ...(doc?.description !== undefined ? { description: doc.description } : {}),
      ...(doc?.tags !== undefined ? { tags: doc.tags } : {}),
      ...(doc?.deprecated !== undefined ? { deprecated: doc.deprecated } : {}),
      ...(doc?.security !== undefined ? { security: doc.security } : {}),
      ...(parameters.length > 0 ? { parameters } : {}),
      ...(requestBody !== undefined ? { requestBody } : {}),
      responses: responsesMutable,
    };

    if (!pathsMutable[openApiPath]) {
      pathsMutable[openApiPath] = {};
    }
    pathsMutable[openApiPath]![methodKey] = operation;
  }

  const sortedPaths: Record<string, OpenApiPathItem> = {};
  for (const pathKey of Object.keys(pathsMutable).sort()) {
    sortedPaths[pathKey] = pathsMutable[pathKey]!;
  }

  let componentSchemas: Record<string, OpenApiSchemaObject> | undefined;
  if (options.schemas && Object.keys(options.schemas).length > 0) {
    componentSchemas = {};
    for (const [name, schemaDef] of Object.entries(options.schemas)) {
      componentSchemas[name] = schemaToJsonSchema(schemaDef, reflectOpts);
    }
  }

  const hasComponents =
    componentSchemas !== undefined || options.securitySchemes !== undefined;

  return {
    openapi: '3.1.0',
    info: {
      title: options.title,
      version: options.version,
      ...(options.description !== undefined ? { description: options.description } : {}),
    },
    ...(options.servers !== undefined ? { servers: options.servers } : {}),
    ...(options.tags !== undefined ? { tags: options.tags } : {}),
    paths: sortedPaths,
    ...(hasComponents
      ? {
          components: {
            ...(componentSchemas !== undefined ? { schemas: componentSchemas } : {}),
            ...(options.securitySchemes !== undefined
              ? { securitySchemes: options.securitySchemes }
              : {}),
          },
        }
      : {}),
    ...(options.security !== undefined ? { security: options.security } : {}),
  };
}
