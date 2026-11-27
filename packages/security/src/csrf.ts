import { ForbiddenError } from '@forge-fr/core';
import type { ForgeContext, ForgeMiddleware } from '@forge-fr/http';

const TEXT_ENCODER = new TextEncoder();

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function constantTimeEqual(a: string, b: string): boolean {
  const bytesA = TEXT_ENCODER.encode(a);
  const bytesB = TEXT_ENCODER.encode(b);
  const maxLen = Math.max(bytesA.length, bytesB.length);
  let diff = bytesA.length ^ bytesB.length;
  for (let i = 0; i < maxLen; i += 1) {
    const ba = i < bytesA.length ? bytesA[i]! : 0;
    const bb = i < bytesB.length ? bytesB[i]! : 0;
    diff |= ba ^ bb;
  }
  return diff === 0;
}

function parseCookieHeader(header: string | null): Record<string, string> {
  const out: Record<string, string> = Object.create(null) as Record<string, string>;
  if (header === null || header.trim().length === 0) {
    return out;
  }
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx <= 0) continue;
    const name = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    if (
      name.length > 0 &&
      name !== '__proto__' &&
      name !== 'constructor' &&
      name !== 'prototype'
    ) {
      out[name] = val;
    }
  }
  return out;
}

export function generateCsrfToken(byteLength = 32): string {
  const bytes = new Uint8Array(byteLength);
  globalThis.crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

export interface CsrfMiddlewareOptions {
  /** Cookie name for double-submit mode (defaults to `'__Host-forge_csrf'`). */
  readonly cookieName?: string;
  /** Request header carrying the submitted CSRF token (defaults to `'x-csrf-token'`). */
  readonly headerName?: string;
  /** Optional synchronizer-token lookup overriding double-submit cookie lookup. */
  readonly getExpectedToken?: (ctx: ForgeContext) => string | null | Promise<string | null>;
  /** Methods exempt from CSRF checks (defaults to `['GET', 'HEAD', 'OPTIONS']`). */
  readonly safeMethods?: readonly string[];
  /** Explicit allowed Origin values (defaults to matching the request's own origin). */
  readonly allowedOrigins?: readonly string[];
  /** Reject requests carrying `Sec-Fetch-Site: cross-site` (defaults to `true`). */
  readonly enforceFetchMetadata?: boolean;
}

const DEFAULT_SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function createCsrfMiddleware(options: CsrfMiddlewareOptions = {}): ForgeMiddleware {
  const cookieName = options.cookieName ?? '__Host-forge_csrf';
  const headerName = (options.headerName ?? 'x-csrf-token').toLowerCase();
  const safeMethods =
    options.safeMethods !== undefined
      ? new Set(options.safeMethods.map((m) => m.toUpperCase()))
      : DEFAULT_SAFE_METHODS;
  const allowedOrigins =
    options.allowedOrigins !== undefined ? new Set(options.allowedOrigins) : null;
  const enforceFetchMetadata = options.enforceFetchMetadata ?? true;

  return async (ctx, next) => {
    if (safeMethods.has(ctx.method.toUpperCase())) {
      return next();
    }

    // 1. Fetch Metadata defense against cross-site state mutations
    if (enforceFetchMetadata) {
      const fetchSite = ctx.request.headers.get('sec-fetch-site')?.trim().toLowerCase();
      if (fetchSite === 'cross-site') {
        throw new ForbiddenError('CSRF validation failed');
      }
    }

    // 2. Origin verification when Origin header is present
    const originHeader = ctx.request.headers.get('origin')?.trim();
    if (originHeader !== undefined && originHeader.length > 0) {
      const requestOrigin = ctx.url.origin;
      const originMatches =
        allowedOrigins !== null
          ? allowedOrigins.has(originHeader)
          : originHeader === requestOrigin;
      if (!originMatches) {
        throw new ForbiddenError('CSRF validation failed');
      }
    }

    // 3. Synchronizer or Double-Submit Token constant-time verification
    const submittedToken = ctx.request.headers.get(headerName)?.trim() ?? '';
    if (submittedToken.length < 16) {
      throw new ForbiddenError('CSRF validation failed');
    }

    let expectedToken: string | null;
    if (options.getExpectedToken !== undefined) {
      expectedToken = await options.getExpectedToken(ctx);
    } else {
      const cookies = parseCookieHeader(ctx.request.headers.get('cookie'));
      expectedToken = cookies[cookieName] ?? null;
    }

    if (
      typeof expectedToken !== 'string' ||
      expectedToken.length < 16 ||
      !constantTimeEqual(expectedToken, submittedToken)
    ) {
      throw new ForbiddenError('CSRF validation failed');
    }

    return next();
  };
}
