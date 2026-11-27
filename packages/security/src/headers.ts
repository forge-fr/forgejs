import { ConfigurationError } from '@forge-fr/core';
import type { ForgeMiddleware } from '@forge-fr/http';

const CONTROL_CHAR_RE = /[\r\n\u0000]/;

function assertSafeHeaderValue(name: string, value: string): string {
  if (typeof value !== 'string' || CONTROL_CHAR_RE.test(value)) {
    throw new ConfigurationError(`Header "${name}" contains forbidden control or CRLF characters`);
  }
  return value;
}

export type CspDirectives = Readonly<Record<string, readonly string[] | string>>;

export function buildCspHeader(directives: CspDirectives): string {
  const parts: string[] = [];
  for (const [directive, rawVal] of Object.entries(directives)) {
    if (!/^[a-z0-9-]+$/i.test(directive)) {
      throw new ConfigurationError(`Invalid CSP directive name "${directive}"`);
    }
    const value = Array.isArray(rawVal) ? rawVal.join(' ') : String(rawVal);
    assertSafeHeaderValue(`CSP:${directive}`, value);
    parts.push(value.trim().length > 0 ? `${directive} ${value.trim()}` : directive);
  }
  return parts.join('; ');
}

export interface HstsOptions {
  readonly maxAgeSeconds?: number;
  readonly includeSubDomains?: boolean;
  readonly preload?: boolean;
}

export interface SecurityHeadersOptions {
  /** Defaults to `'nosniff'`. Set to `false` to disable. */
  readonly contentTypeOptions?: 'nosniff' | false;
  /** Defaults to `'DENY'`. Set to `false` to disable. */
  readonly frameOptions?: 'DENY' | 'SAMEORIGIN' | false;
  /** Defaults to `'no-referrer'`. Set to `false` to disable. */
  readonly referrerPolicy?: string | false;
  /** Defaults to `'same-origin'`. Set to `false` to disable. */
  readonly crossOriginOpenerPolicy?: string | false;
  /** Defaults to `'same-origin'`. Set to `false` to disable. */
  readonly crossOriginResourcePolicy?: string | false;
  /** Defaults to `'camera=(), microphone=(), geolocation=(), payment=()'`. Set to `false` to disable. */
  readonly permissionsPolicy?: string | false;
  /** Optional Content-Security-Policy string or directive map. */
  readonly contentSecurityPolicy?: string | CspDirectives | false;
  /**
   * Strict-Transport-Security policy. Applied automatically on HTTPS requests (or when
   * `alwaysSendHsts: true`). Defaults to `max-age=31536000; includeSubDomains`.
   */
  readonly hsts?: HstsOptions | boolean;
  readonly alwaysSendHsts?: boolean;
  /** Headers to strip from outgoing responses (defaults to `['x-powered-by']`). */
  readonly removeHeaders?: readonly string[];
}

const DEFAULT_PERMISSIONS_POLICY = 'camera=(), microphone=(), geolocation=(), payment=()';

function formatHsts(hsts: HstsOptions | boolean | undefined): string | null {
  if (hsts === false) {
    return null;
  }
  const opts: HstsOptions = typeof hsts === 'object' ? hsts : {};
  const maxAge = opts.maxAgeSeconds ?? 31_536_000;
  if (!Number.isInteger(maxAge) || maxAge < 0) {
    throw new ConfigurationError('HSTS maxAgeSeconds must be a non-negative integer');
  }
  const segments = [`max-age=${maxAge}`];
  if (opts.includeSubDomains ?? true) {
    segments.push('includeSubDomains');
  }
  if (opts.preload === true) {
    segments.push('preload');
  }
  return segments.join('; ');
}

export function createSecurityHeadersMiddleware(
  options: SecurityHeadersOptions = {},
): ForgeMiddleware {
  const staticHeaders: [string, string][] = [];

  if (options.contentTypeOptions !== false) {
    staticHeaders.push([
      'x-content-type-options',
      assertSafeHeaderValue('x-content-type-options', options.contentTypeOptions ?? 'nosniff'),
    ]);
  }
  if (options.frameOptions !== false) {
    staticHeaders.push([
      'x-frame-options',
      assertSafeHeaderValue('x-frame-options', options.frameOptions ?? 'DENY'),
    ]);
  }
  if (options.referrerPolicy !== false) {
    staticHeaders.push([
      'referrer-policy',
      assertSafeHeaderValue('referrer-policy', options.referrerPolicy ?? 'no-referrer'),
    ]);
  }
  if (options.crossOriginOpenerPolicy !== false) {
    staticHeaders.push([
      'cross-origin-opener-policy',
      assertSafeHeaderValue(
        'cross-origin-opener-policy',
        options.crossOriginOpenerPolicy ?? 'same-origin',
      ),
    ]);
  }
  if (options.crossOriginResourcePolicy !== false) {
    staticHeaders.push([
      'cross-origin-resource-policy',
      assertSafeHeaderValue(
        'cross-origin-resource-policy',
        options.crossOriginResourcePolicy ?? 'same-origin',
      ),
    ]);
  }
  if (options.permissionsPolicy !== false) {
    staticHeaders.push([
      'permissions-policy',
      assertSafeHeaderValue(
        'permissions-policy',
        options.permissionsPolicy ?? DEFAULT_PERMISSIONS_POLICY,
      ),
    ]);
  }
  if (options.contentSecurityPolicy !== undefined && options.contentSecurityPolicy !== false) {
    const csp =
      typeof options.contentSecurityPolicy === 'string'
        ? assertSafeHeaderValue('content-security-policy', options.contentSecurityPolicy)
        : buildCspHeader(options.contentSecurityPolicy);
    staticHeaders.push(['content-security-policy', csp]);
  }

  const hstsValue = formatHsts(options.hsts);
  const alwaysSendHsts = options.alwaysSendHsts ?? false;
  const removeHeaders = (options.removeHeaders ?? ['x-powered-by']).map((h) => h.toLowerCase());

  return async (ctx, next) => {
    // Stage on ctx BEFORE next() so both normal and error responses receive hardened headers
    for (const [name, value] of staticHeaders) {
      ctx.setHeader(name, value);
    }

    if (hstsValue !== null && (alwaysSendHsts || ctx.url.protocol === 'https:')) {
      ctx.setHeader('strict-transport-security', hstsValue);
    }

    const response = await next();

    if (removeHeaders.length === 0) {
      return response;
    }

    let shouldStrip = false;
    for (const headerName of removeHeaders) {
      if (response.headers.has(headerName)) {
        shouldStrip = true;
        break;
      }
    }
    if (!shouldStrip) {
      return response;
    }

    const cleanedHeaders = new Headers(response.headers);
    for (const headerName of removeHeaders) {
      cleanedHeaders.delete(headerName);
    }

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: cleanedHeaders,
    });
  };
}
