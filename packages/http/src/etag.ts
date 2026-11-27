import { attachFastBody, getFastBody } from './fast-body.js';
import type { ForgeMiddleware } from './types.js';

export interface EtagOptions {
  /** Emit weak ETags (`W/"..."`) by default (recommended for JSON/dynamic payloads). Default: `true`. */
  readonly weak?: boolean;
}

const utf8Encoder = new TextEncoder();

async function computeSha256Hex(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', copy.buffer);
  const hashBytes = new Uint8Array(digest);
  let hex = '';
  for (const byte of hashBytes) {
    hex += byte.toString(16).padStart(2, '0');
  }
  return hex.slice(0, 32);
}

function normalizeTagForWeakCompare(tag: string): string {
  const trimmed = tag.trim();
  return trimmed.startsWith('W/') ? trimmed.slice(2) : trimmed;
}

function matchesIfNoneMatch(headerValue: string | null, currentEtag: string, weak: boolean): boolean {
  if (!headerValue) {
    return false;
  }
  const trimmed = headerValue.trim();
  if (trimmed === '*') {
    return true;
  }

  const normalizedCurrent = normalizeTagForWeakCompare(currentEtag);
  for (const part of trimmed.split(',')) {
    const candidate = part.trim();
    if (!candidate) continue;
    if (weak) {
      if (normalizeTagForWeakCompare(candidate) === normalizedCurrent) {
        return true;
      }
    } else if (candidate === currentEtag && !candidate.startsWith('W/')) {
      return true;
    }
  }
  return false;
}

function buildNotModifiedHeaders(source: Headers, etag: string): Headers {
  const headers = new Headers();
  const preserved = ['cache-control', 'content-location', 'date', 'etag', 'expires', 'vary'];
  for (const name of preserved) {
    const val = source.get(name);
    if (val !== null) {
      headers.set(name, val);
    }
  }
  headers.set('etag', etag);
  return headers;
}

export function createEtagMiddleware(options: EtagOptions = {}): ForgeMiddleware {
  const weak = options.weak ?? true;

  return async function etagMiddleware(ctx, next) {
    const response = await next();

    if ((ctx.method !== 'GET' && ctx.method !== 'HEAD') || response.status !== 200) {
      return response;
    }

    const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
    if (contentType.startsWith('text/event-stream')) {
      return response;
    }

    let etag = response.headers.get('etag');
    let bufferedBytes: Uint8Array | undefined;
    const contentEncoding = response.headers.get('content-encoding')?.trim().toLowerCase();

    if (!etag) {
      const fastBody = getFastBody(response);
      if (fastBody !== undefined) {
        bufferedBytes = typeof fastBody === 'string' ? utf8Encoder.encode(fastBody) : fastBody;
      } else if (response.body !== null) {
        bufferedBytes = new Uint8Array(await response.arrayBuffer());
      } else {
        bufferedBytes = new Uint8Array(0);
      }

      const hash = await computeSha256Hex(bufferedBytes);
      if (weak) {
        etag = `W/"${hash}"`;
      } else if (contentEncoding) {
        etag = `"${hash}-${contentEncoding}"`;
      } else {
        etag = `"${hash}"`;
      }
    }

    if (matchesIfNoneMatch(ctx.header('if-none-match'), etag, weak)) {
      return new Response(null, {
        status: 304,
        headers: buildNotModifiedHeaders(response.headers, etag),
      });
    }

    if (response.headers.get('etag') === etag && bufferedBytes === undefined) {
      return response;
    }

    const headers = new Headers(response.headers);
    headers.set('etag', etag);

    if (bufferedBytes !== undefined) {
      const fastBody = getFastBody(response);
      const copy = new Uint8Array(bufferedBytes.byteLength);
      copy.set(bufferedBytes);
      const out = new Response(copy, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
      return fastBody !== undefined ? attachFastBody(out, fastBody) : out;
    }

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  };
}
