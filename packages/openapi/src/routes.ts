import type { ForgeMiddleware, ForgeRouteHandler } from '@forge-fr/http';
import {
  getAttachedValidationSchemas,
  validatedHandler,
  type AnySchema,
  type HttpValidationOptions,
  type RouteValidationSchemas,
  type ValidatedRouteHandler,
} from '@forge-fr/validation';
import type { OpenApiRouteDoc } from './types.js';

export const OPENAPI_META_KEY = '__forgejs_openapi__';

export interface OpenApiHandlerMetadata {
  readonly schemas?: RouteValidationSchemas;
  readonly doc?: OpenApiRouteDoc;
}

const handlerOpenApiStore = new WeakMap<ForgeRouteHandler, OpenApiHandlerMetadata>();

export function openApiMeta(
  doc: OpenApiRouteDoc,
  schemas?: RouteValidationSchemas,
): Readonly<Record<string, unknown>> {
  return {
    [OPENAPI_META_KEY]: {
      ...(schemas !== undefined ? { schemas } : {}),
      doc,
    } satisfies OpenApiHandlerMetadata,
  };
}

export function attachOpenApiMetadata(
  handler: ForgeRouteHandler,
  meta: OpenApiHandlerMetadata,
): ForgeRouteHandler {
  handlerOpenApiStore.set(handler, meta);
  return handler;
}

export function getAttachedOpenApiMetadata(
  handler: ForgeRouteHandler,
  routeMeta?: Readonly<Record<string, unknown>>,
  routeMiddlewares?: readonly ForgeMiddleware[],
): OpenApiHandlerMetadata | undefined {
  const fromHandler = handlerOpenApiStore.get(handler);
  const fromValidatedHandler = getAttachedValidationSchemas(handler);

  let fromMiddlewareSchemas: RouteValidationSchemas | undefined;
  if (routeMiddlewares && routeMiddlewares.length > 0) {
    for (const mw of routeMiddlewares) {
      const mwSchemas = getAttachedValidationSchemas(mw);
      if (mwSchemas) {
        fromMiddlewareSchemas = {
          ...(fromMiddlewareSchemas ?? {}),
          ...mwSchemas,
        };
      }
    }
  }

  const fromRouteMeta =
    routeMeta && typeof routeMeta[OPENAPI_META_KEY] === 'object' && routeMeta[OPENAPI_META_KEY] !== null
      ? (routeMeta[OPENAPI_META_KEY] as OpenApiHandlerMetadata)
      : undefined;

  if (!fromHandler && !fromValidatedHandler && !fromMiddlewareSchemas && !fromRouteMeta) {
    return undefined;
  }

  const mergedDoc =
    fromHandler?.doc || fromRouteMeta?.doc
      ? {
          ...(fromHandler?.doc ?? {}),
          ...(fromRouteMeta?.doc ?? {}),
        }
      : undefined;
  const mergedSchemas =
    fromMiddlewareSchemas || fromValidatedHandler || fromHandler?.schemas || fromRouteMeta?.schemas
      ? {
          ...(fromMiddlewareSchemas ?? {}),
          ...(fromValidatedHandler ?? {}),
          ...(fromHandler?.schemas ?? {}),
          ...(fromRouteMeta?.schemas ?? {}),
        }
      : undefined;

  return {
    ...(mergedSchemas !== undefined ? { schemas: mergedSchemas } : {}),
    ...(mergedDoc !== undefined ? { doc: mergedDoc } : {}),
  };
}

/**
 * Wraps `@forge-fr/validation`'s `validatedHandler()` while capturing full schema &
 * OpenAPI documentation metadata for automatic route introspection.
 */
export function validatedOpenApiHandler<
  TBody extends AnySchema | undefined = undefined,
  TQuery extends AnySchema | undefined = undefined,
  TParams extends AnySchema | undefined = undefined,
  THeaders extends AnySchema | undefined = undefined,
  TResponse extends AnySchema | undefined = undefined,
>(
  schemas: RouteValidationSchemas<TBody, TQuery, TParams, THeaders, TResponse>,
  handler: ValidatedRouteHandler<RouteValidationSchemas<TBody, TQuery, TParams, THeaders, TResponse>>,
  doc?: OpenApiRouteDoc,
  validationOptions: HttpValidationOptions = {},
): ForgeRouteHandler {
  const wrapped = validatedHandler(schemas, handler, validationOptions);
  attachOpenApiMetadata(wrapped, {
    schemas: schemas as RouteValidationSchemas,
    ...(doc !== undefined ? { doc } : {}),
  });
  return wrapped;
}
