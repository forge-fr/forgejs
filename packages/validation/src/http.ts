import type { ForgeContext, ForgeMiddleware, ForgeRouteHandler, RouteHandlerResult } from '@forge-fr/http';
import { compileFastValidator, validateOrThrow, validateOrThrowSyncOrAsync } from './engine.js';
import type {
  AnySchema,
  HttpValidationOptions,
  RouteValidationSchemas,
  ValidatedInput,
} from './types.js';

export const VALIDATED_STATE_KEY = '__forgejs_validated__';
export const VALIDATION_SCHEMAS_SYMBOL: unique symbol = Symbol.for('forgejs.validation.schemas');

function attachValidationSchemas<TFn extends ForgeRouteHandler | ForgeMiddleware>(
  fn: TFn,
  schemas: RouteValidationSchemas,
): TFn {
  Object.defineProperty(fn, VALIDATION_SCHEMAS_SYMBOL, {
    value: schemas,
    enumerable: false,
    configurable: true,
    writable: false,
  });
  return fn;
}

export function getAttachedValidationSchemas(
  target: unknown,
): RouteValidationSchemas | undefined {
  if (typeof target !== 'function' && (typeof target !== 'object' || target === null)) {
    return undefined;
  }
  const attached = (target as Record<symbol, unknown>)[VALIDATION_SCHEMAS_SYMBOL];
  if (typeof attached === 'object' && attached !== null) {
    return attached as RouteValidationSchemas;
  }
  return undefined;
}

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function extractSafeQueryObject(url: URL): Record<string, string | string[]> {
  const result: Record<string, string | string[]> = Object.create(null) as Record<
    string,
    string | string[]
  >;
  for (const [key, value] of url.searchParams.entries()) {
    if (FORBIDDEN_KEYS.has(key)) {
      continue;
    }
    const existing = result[key];
    if (existing === undefined) {
      result[key] = value;
    } else if (Array.isArray(existing)) {
      existing.push(value);
    } else {
      result[key] = [existing, value];
    }
  }
  return result;
}

function extractSafeHeadersObject(headers: Headers): Record<string, string> {
  const result: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [key, value] of headers.entries()) {
    const normalized = key.toLowerCase();
    if (FORBIDDEN_KEYS.has(normalized)) {
      continue;
    }
    result[normalized] = value;
  }
  return result;
}

interface FastValidatableContext extends ForgeContext {
  _readValidationBody?(options: HttpValidationOptions): Promise<unknown>;
  _validated?: unknown;
}

function parseRequestBodyForValidation(
  ctx: ForgeContext,
  options: HttpValidationOptions,
): Promise<unknown> {
  const fastCtx = ctx as FastValidatableContext;
  if (typeof fastCtx._readValidationBody === 'function') {
    return fastCtx._readValidationBody(options);
  }
  const rawCt = ctx.header('content-type');
  if (
    rawCt !== null &&
    (rawCt === 'application/x-www-form-urlencoded' ||
      rawCt.startsWith('application/x-www-form-urlencoded;'))
  ) {
    return ctx.body.form(
      options.maxBodyBytes !== undefined ? { maxBytes: options.maxBodyBytes } : undefined,
    );
  }
  return ctx.body.json({
    ...(options.maxBodyBytes !== undefined ? { maxBytes: options.maxBodyBytes } : {}),
    ...(options.allowProtoKeys !== undefined ? { allowProtoKeys: options.allowProtoKeys } : {}),
  });
}

function isJsonResponse(response: Response): boolean {
  const ct = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() ?? '';
  return ct === 'application/json' || ct.endsWith('+json');
}

const BODY_TARGET_OPT = { target: 'body' as const };
const PARAMS_TARGET_OPT = { target: 'params' as const };
const QUERY_TARGET_OPT = { target: 'query' as const };
const HEADERS_TARGET_OPT = { target: 'headers' as const };

function validateInputPartsSyncOrAsync<TSchemas extends RouteValidationSchemas>(
  ctx: ForgeContext,
  schemas: TSchemas,
  options: HttpValidationOptions,
): Promise<ValidatedInput<TSchemas>> | ValidatedInput<TSchemas> {
  const paramsSchema = schemas.params;
  const querySchema = schemas.query;
  const headersSchema = schemas.headers;
  const bodySchema = schemas.body;

  // Fast path: body-only validation (most common POST/PUT/PATCH JSON route)
  if (
    bodySchema !== undefined &&
    paramsSchema === undefined &&
    querySchema === undefined &&
    headersSchema === undefined
  ) {
    return parseRequestBodyForValidation(ctx, options).then((rawBody) => {
      const b = validateOrThrowSyncOrAsync(bodySchema, rawBody, BODY_TARGET_OPT);
      if (b instanceof Promise) {
        return b.then(
          (resolvedBody) =>
            ({
              params: undefined,
              query: undefined,
              headers: undefined,
              body: resolvedBody,
            }) as ValidatedInput<TSchemas>,
        );
      }
      return {
        params: undefined,
        query: undefined,
        headers: undefined,
        body: b,
      } as ValidatedInput<TSchemas>;
    });
  }

  // Fast path: synchronous params/query/headers validation without body
  if (bodySchema === undefined) {
    const p =
      paramsSchema !== undefined
        ? validateOrThrowSyncOrAsync(paramsSchema, ctx.params, PARAMS_TARGET_OPT)
        : undefined;
    const q =
      querySchema !== undefined
        ? validateOrThrowSyncOrAsync(querySchema, extractSafeQueryObject(ctx.url), QUERY_TARGET_OPT)
        : undefined;
    const h =
      headersSchema !== undefined
        ? validateOrThrowSyncOrAsync(
            headersSchema,
            extractSafeHeadersObject(ctx.headers),
            HEADERS_TARGET_OPT,
          )
        : undefined;

    if (!(p instanceof Promise) && !(q instanceof Promise) && !(h instanceof Promise)) {
      return {
        params: p,
        query: q,
        headers: h,
        body: undefined,
      } as ValidatedInput<TSchemas>;
    }
  }

  return validateInputPartsAsync(ctx, schemas, options);
}

async function validateInputPartsAsync<TSchemas extends RouteValidationSchemas>(
  ctx: ForgeContext,
  schemas: TSchemas,
  options: HttpValidationOptions,
): Promise<ValidatedInput<TSchemas>> {
  let params: unknown;
  if (schemas.params) {
    const p = validateOrThrowSyncOrAsync(schemas.params, ctx.params, PARAMS_TARGET_OPT);
    params = p instanceof Promise ? await p : p;
  }

  let query: unknown;
  if (schemas.query) {
    const q = validateOrThrowSyncOrAsync(
      schemas.query,
      extractSafeQueryObject(ctx.url),
      QUERY_TARGET_OPT,
    );
    query = q instanceof Promise ? await q : q;
  }

  let headers: unknown;
  if (schemas.headers) {
    const h = validateOrThrowSyncOrAsync(
      schemas.headers,
      extractSafeHeadersObject(ctx.headers),
      HEADERS_TARGET_OPT,
    );
    headers = h instanceof Promise ? await h : h;
  }

  let body: unknown;
  if (schemas.body) {
    const rawBody = await parseRequestBodyForValidation(ctx, options);
    const b = validateOrThrowSyncOrAsync(schemas.body, rawBody, BODY_TARGET_OPT);
    body = b instanceof Promise ? await b : b;
  }

  return {
    params,
    query,
    headers,
    body,
  } as ValidatedInput<TSchemas>;
}

async function applyResponseValidation(
  response: Response,
  responseSchema: AnySchema,
  options: HttpValidationOptions,
): Promise<Response> {
  if (response.status === 204 || response.status === 304) {
    return response;
  }

  if (!isJsonResponse(response) && options.validateNonJsonResponse !== true) {
    return response;
  }

  let parsedPayload: unknown;
  try {
    parsedPayload = await response.json();
  } catch (err: unknown) {
    await validateOrThrow(responseSchema, undefined, {
      target: 'response',
      message:
        err instanceof Error
          ? `Response body is not valid JSON: ${err.message}`
          : 'Response body is not valid JSON',
    });
    return response;
  }

  const validatedPayload = await validateOrThrow(responseSchema, parsedPayload, {
    target: 'response',
  });

  const headers = new Headers(response.headers);
  headers.delete('content-length');
  if (!headers.has('content-type')) {
    headers.set('content-type', 'application/json; charset=utf-8');
  }

  return new Response(JSON.stringify(validatedPayload), {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export function getValidated<T extends Partial<Record<'body' | 'query' | 'params' | 'headers', unknown>>>(
  ctx: ForgeContext,
): T {
  const fastCtx = ctx as FastValidatableContext;
  const stored = (fastCtx._validated as T | undefined) ?? ctx.getState<T>(VALIDATED_STATE_KEY);
  if (stored === undefined) {
    throw new Error(
      'No validated input found on ForgeContext. Attach validateRequest() middleware or use validatedHandler().',
    );
  }
  return stored;
}

export function validateRequest<TSchemas extends RouteValidationSchemas>(
  schemas: TSchemas,
  options: HttpValidationOptions = {},
): ForgeMiddleware {
  const responseSchema = schemas.response;
  return attachValidationSchemas(function forgeValidationMiddleware(ctx, next) {
    const fastCtx = ctx as FastValidatableContext;
    const validatedOrPromise = validateInputPartsSyncOrAsync(ctx, schemas, options);
    if (validatedOrPromise instanceof Promise) {
      return validatedOrPromise.then((validated) => {
        fastCtx._validated = validated;
        const resOrPromise = next();
        if (!responseSchema) {
          return resOrPromise;
        }
        return Promise.resolve(resOrPromise).then((response) => {
          if (response.status >= 200 && response.status < 300) {
            return applyResponseValidation(response, responseSchema, options);
          }
          return response;
        });
      });
    }

    fastCtx._validated = validatedOrPromise;
    const resOrPromise = next();
    if (!responseSchema) {
      return resOrPromise;
    }
    return Promise.resolve(resOrPromise).then((response) => {
      if (response.status >= 200 && response.status < 300) {
        return applyResponseValidation(response, responseSchema, options);
      }
      return response;
    });
  }, schemas);
}

export type ValidatedRouteHandler<TSchemas extends RouteValidationSchemas> = (
  ctx: ForgeContext,
  input: ValidatedInput<TSchemas>,
) => Promise<RouteHandlerResult> | RouteHandlerResult;

export function validatedHandler<
  TBody extends AnySchema | undefined = undefined,
  TQuery extends AnySchema | undefined = undefined,
  TParams extends AnySchema | undefined = undefined,
  THeaders extends AnySchema | undefined = undefined,
  TResponse extends AnySchema | undefined = undefined,
>(
  schemas: RouteValidationSchemas<TBody, TQuery, TParams, THeaders, TResponse>,
  handler: ValidatedRouteHandler<RouteValidationSchemas<TBody, TQuery, TParams, THeaders, TResponse>>,
  options: HttpValidationOptions = {},
): ForgeRouteHandler {
  const responseSchema = schemas.response;
  const typedSchemas = schemas as RouteValidationSchemas;

  // Ultra-fast specialized path for body-only validation without response schema
  if (
    !responseSchema &&
    schemas.body !== undefined &&
    schemas.params === undefined &&
    schemas.query === undefined &&
    schemas.headers === undefined
  ) {
    const validateBody = compileFastValidator(schemas.body, BODY_TARGET_OPT);
    return attachValidationSchemas(function forgeValidatedBodyFastHandler(ctx) {
      const fastCtx = ctx as FastValidatableContext;
      const bodyPromise =
        typeof fastCtx._readValidationBody === 'function'
          ? fastCtx._readValidationBody(options)
          : parseRequestBodyForValidation(ctx, options);
      return bodyPromise.then((rawBody) => {
        const b = validateBody(rawBody);
        if (b instanceof Promise) {
          return b.then((resolvedBody) => {
            const validated = {
              params: undefined,
              query: undefined,
              headers: undefined,
              body: resolvedBody,
            } as ValidatedInput<RouteValidationSchemas<TBody, TQuery, TParams, THeaders, TResponse>>;
            fastCtx._validated = validated;
            return handler(ctx, validated);
          });
        }
        const validated = {
          params: undefined,
          query: undefined,
          headers: undefined,
          body: b,
        } as ValidatedInput<RouteValidationSchemas<TBody, TQuery, TParams, THeaders, TResponse>>;
        fastCtx._validated = validated;
        return handler(ctx, validated);
      });
    }, typedSchemas);
  }

  if (!responseSchema) {
    return attachValidationSchemas(function forgeValidatedFastHandler(ctx) {
      const fastCtx = ctx as FastValidatableContext;
      const validatedOrPromise = validateInputPartsSyncOrAsync(ctx, schemas, options);
      if (validatedOrPromise instanceof Promise) {
        return validatedOrPromise.then((validated) => {
          fastCtx._validated = validated;
          return handler(ctx, validated);
        });
      }
      fastCtx._validated = validatedOrPromise;
      return handler(ctx, validatedOrPromise);
    }, typedSchemas);
  }

  return attachValidationSchemas(async function forgeValidatedRouteHandler(ctx) {
    const fastCtx = ctx as FastValidatableContext;
    const validatedOrPromise = validateInputPartsSyncOrAsync(ctx, schemas, options);
    const validated =
      validatedOrPromise instanceof Promise ? await validatedOrPromise : validatedOrPromise;
    fastCtx._validated = validated;

    const result = await handler(ctx, validated);

    if (result instanceof Response) {
      if (result.status >= 200 && result.status < 300) {
        return applyResponseValidation(result, responseSchema, options);
      }
      return result;
    }

    const validatedPayload = await validateOrThrow(responseSchema, result, {
      target: 'response',
    });
    return ctx.json(validatedPayload);
  }, typedSchemas);
}
