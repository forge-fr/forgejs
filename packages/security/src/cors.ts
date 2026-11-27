import { ConfigurationError, ForbiddenError } from '@forge-fr/core';
import type { ForgeMiddleware } from '@forge-fr/http';

const CONTROL_CHAR_RE = /[\r\n\u0000]/;

export type CorsOriginRule =
  | string
  | readonly string[]
  | RegExp
  | ((origin: string) => boolean);

export interface CorsOptions {
  /**
   * Explicit allowed origin(s). Disabled (same-origin) if omitted or empty.
   * Combining `'*'` with `credentials: true` throws a fatal startup `ConfigurationError`.
   */
  readonly origin?: CorsOriginRule;
  readonly credentials?: boolean;
  readonly methods?: readonly string[];
  readonly allowedHeaders?: readonly string[];
  readonly exposedHeaders?: readonly string[];
  readonly maxAgeSeconds?: number;
}

function validateHeaderList(values: readonly string[], label: string): string {
  for (const v of values) {
    if (typeof v !== 'string' || v.trim().length === 0 || CONTROL_CHAR_RE.test(v)) {
      throw new ConfigurationError(`Invalid ${label} entry in CORS configuration`);
    }
  }
  return values.join(', ');
}

function isWildcardOrigin(origin: CorsOriginRule | undefined): boolean {
  if (origin === '*') {
    return true;
  }
  if (Array.isArray(origin)) {
    return origin.includes('*');
  }
  return false;
}

function isOriginAllowed(origin: string, rule: CorsOriginRule | undefined): boolean {
  if (rule === undefined || origin.length === 0 || CONTROL_CHAR_RE.test(origin)) {
    return false;
  }
  // Never reflect opaque 'null' origin unless explicitly configured in an exact allowlist
  if (rule === '*') {
    return true;
  }
  if (typeof rule === 'string') {
    return origin === rule;
  }
  if (Array.isArray(rule)) {
    return rule.includes(origin);
  }
  if (rule instanceof RegExp) {
    return origin !== 'null' && rule.test(origin);
  }
  if (typeof rule === 'function') {
    return rule(origin) === true;
  }
  return false;
}

export function createCorsMiddleware(options: CorsOptions = {}): ForgeMiddleware {
  const credentials = options.credentials ?? false;
  const wildcard = isWildcardOrigin(options.origin);

  // OWASP ASVS hard-error: wildcard origin + credentials is forbidden
  if (wildcard && credentials) {
    throw new ConfigurationError(
      'CORS configuration cannot combine wildcard origin "*" with credentials: true',
    );
  }

  const methodsHeader = validateHeaderList(
    options.methods ?? ['GET', 'HEAD', 'PUT', 'PATCH', 'POST', 'DELETE'],
    'methods',
  );
  const allowedHeadersHeader =
    options.allowedHeaders !== undefined
      ? validateHeaderList(options.allowedHeaders, 'allowedHeaders')
      : null;
  const exposedHeadersHeader =
    options.exposedHeaders !== undefined && options.exposedHeaders.length > 0
      ? validateHeaderList(options.exposedHeaders, 'exposedHeaders')
      : null;

  if (
    options.maxAgeSeconds !== undefined &&
    (!Number.isInteger(options.maxAgeSeconds) || options.maxAgeSeconds < 0)
  ) {
    throw new ConfigurationError('CORS maxAgeSeconds must be a non-negative integer');
  }

  return async (ctx, next) => {
    const requestOrigin = ctx.request.headers.get('origin');
    const isPreflight =
      ctx.method === 'OPTIONS' &&
      requestOrigin !== null &&
      ctx.request.headers.has('access-control-request-method');

    if (requestOrigin === null) {
      return next();
    }

    const allowed = isOriginAllowed(requestOrigin, options.origin);
    if (!allowed) {
      if (isPreflight) {
        throw new ForbiddenError('CORS origin not allowed');
      }
      return next();
    }

    const allowOriginValue = wildcard ? '*' : requestOrigin;
    ctx.setHeader('access-control-allow-origin', allowOriginValue);
    if (!wildcard) {
      ctx.appendHeader('vary', 'Origin');
    }
    if (credentials) {
      ctx.setHeader('access-control-allow-credentials', 'true');
    }

    if (isPreflight) {
      ctx.setHeader('access-control-allow-methods', methodsHeader);
      if (allowedHeadersHeader !== null) {
        ctx.setHeader('access-control-allow-headers', allowedHeadersHeader);
      } else {
        const reqHeaders = ctx.request.headers.get('access-control-request-headers');
        if (reqHeaders !== null && !CONTROL_CHAR_RE.test(reqHeaders)) {
          ctx.setHeader('access-control-allow-headers', reqHeaders);
          ctx.appendHeader('vary', 'Access-Control-Request-Headers');
        }
      }
      if (options.maxAgeSeconds !== undefined) {
        ctx.setHeader('access-control-max-age', String(options.maxAgeSeconds));
      }
      return ctx.empty(204);
    }

    if (exposedHeadersHeader !== null) {
      ctx.setHeader('access-control-expose-headers', exposedHeadersHeader);
    }

    return next();
  };
}
