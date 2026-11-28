import type {
  ForgeContext,
  ForgeHttpApp,
  ForgeMiddleware,
  MiddlewareNext,
} from '@forge-fr/http';
import { createCorsMiddleware, type CorsOptions } from './cors.js';
import { createCsrfMiddleware, type CsrfMiddlewareOptions } from './csrf.js';
import {
  createSecurityHeadersMiddleware,
  type SecurityHeadersOptions,
} from './headers.js';
import {
  createRateLimitMiddleware,
  type RateLimitMiddlewareOptions,
} from './rate-limit.js';

export interface SecurityMiddlewareOptions {
  /**
   * Security response headers configuration. Enabled with OWASP defaults unless set to `false`.
   */
  readonly headers?: SecurityHeadersOptions | false;
  /**
   * CORS configuration. Disabled unless explicitly configured.
   */
  readonly cors?: CorsOptions | false;
  /**
   * Rate-limiting configuration. Disabled unless explicitly configured.
   */
  readonly rateLimit?: RateLimitMiddlewareOptions | false;
  /**
   * CSRF protection configuration. Disabled unless explicitly configured.
   */
  readonly csrf?: CsrfMiddlewareOptions | false;
  /**
   * Whether CORS preflight `OPTIONS` requests consume rate-limit quota.
   * Defaults to `false` so browser preflights do not exhaust user rate limits.
   */
  readonly rateLimitPreflight?: boolean;
}

function isCorsPreflightRequest(ctx: ForgeContext): boolean {
  return (
    ctx.method === 'OPTIONS' &&
    ctx.request.headers.get('origin') !== null &&
    ctx.request.headers.has('access-control-request-method')
  );
}

function chainSecurityMiddlewares(stack: readonly ForgeMiddleware[]): ForgeMiddleware {
  if (stack.length === 0) {
    return (_ctx, next) => next();
  }
  if (stack.length === 1) {
    return stack[0]!;
  }
  return (ctx: ForgeContext, outerNext: MiddlewareNext): Promise<Response> => {
    const dispatch = async (index: number): Promise<Response> => {
      if (index >= stack.length) {
        return outerNext();
      }
      const mw = stack[index]!;
      let nextResponse: Response | undefined;
      let calledNext = false;
      const result = await mw(ctx, async () => {
        calledNext = true;
        nextResponse = await dispatch(index + 1);
        return nextResponse;
      });
      if (result instanceof Response) {
        return result;
      }
      if (calledNext && nextResponse !== undefined) {
        return nextResponse;
      }
      return outerNext();
    };
    return dispatch(0);
  };
}

/**
 * Composes ForgeJS security middleware in OWASP-safe execution order:
 * `headers` -> `cors` -> `rateLimit` -> `csrf`.
 *
 * Placing `headers` and `cors` ahead of `rateLimit` and `csrf` guarantees that
 * `429 Too Many Requests`, `403 Forbidden`, and `500` error responses still carry
 * security and `Access-Control-Allow-Origin` headers, and that valid CORS preflight
 * requests return `204` without triggering CSRF errors.
 */
export function createSecurityMiddleware(
  options: SecurityMiddlewareOptions = {},
): ForgeMiddleware {
  const stack: ForgeMiddleware[] = [];

  if (options.headers !== false) {
    stack.push(createSecurityHeadersMiddleware(options.headers));
  }

  const corsMw =
    options.cors !== undefined && options.cors !== false
      ? createCorsMiddleware(options.cors)
      : null;

  const rateLimitMw =
    options.rateLimit !== undefined && options.rateLimit !== false
      ? createRateLimitMiddleware(options.rateLimit)
      : null;

  const csrfMw =
    options.csrf !== undefined && options.csrf !== false
      ? createCsrfMiddleware(options.csrf)
      : null;

  if (corsMw !== null && rateLimitMw !== null && options.rateLimitPreflight === true) {
    // Allow CORS to validate origin and stage ACAO headers first, then apply rate limit
    // even for preflight requests when explicitly opted in.
    stack.push(async (ctx, next) => {
      if (isCorsPreflightRequest(ctx)) {
        const preflightRes = await corsMw(ctx, next);
        await rateLimitMw(ctx, async () => preflightRes ?? ctx.empty(204));
        return preflightRes;
      }
      return corsMw(ctx, next);
    });
    stack.push(rateLimitMw);
  } else {
    if (corsMw !== null) {
      stack.push(corsMw);
    }
    if (rateLimitMw !== null) {
      stack.push(rateLimitMw);
    }
  }

  if (csrfMw !== null) {
    stack.push(csrfMw);
  }

  return chainSecurityMiddlewares(stack);
}

/**
 * Attaches the unified ForgeJS security stack to a `ForgeHttpApp`.
 *
 * When `cors` is configured, also registers an `onRequest` hook that intercepts
 * CORS preflight `OPTIONS` requests before route matching so routes registered only
 * for `GET`/`POST`/etc. answer preflights with `204` instead of `405 Method Not Allowed`.
 */
export function attachSecurity(
  app: ForgeHttpApp,
  options: SecurityMiddlewareOptions = {},
): ForgeHttpApp {
  const securityMiddleware = createSecurityMiddleware(options);

  if (options.cors !== undefined && options.cors !== false) {
    const preflightStack: ForgeMiddleware[] = [];
    if (options.headers !== false) {
      preflightStack.push(createSecurityHeadersMiddleware(options.headers));
    }
    const corsMw = createCorsMiddleware(options.cors);
    const rateLimitMw =
      options.rateLimitPreflight === true &&
      options.rateLimit !== undefined &&
      options.rateLimit !== false
        ? createRateLimitMiddleware(options.rateLimit)
        : null;

    if (rateLimitMw !== null) {
      preflightStack.push(async (ctx, next) => {
        const res = await corsMw(ctx, next);
        await rateLimitMw(ctx, async () => res ?? ctx.empty(204));
        return res;
      });
    } else {
      preflightStack.push(corsMw);
    }

    const preflightHandler = chainSecurityMiddlewares(preflightStack);
    app.addHook(
      'onRequest',
      async ({ ctx }) => {
        if (!isCorsPreflightRequest(ctx)) {
          return undefined;
        }
        return preflightHandler(ctx, async () => ctx.empty(204));
      },
      { priority: -100 },
    );
  }

  app.use(securityMiddleware, {
    tier: 'global',
    priority: -100,
    name: 'forge-security',
  });

  return app;
}
