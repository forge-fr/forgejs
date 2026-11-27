import { ConfigurationError } from '@forge-fr/core';

const COOKIE_NAME_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const CONTROL_CHAR_RE = /[\r\n\u0000-\u001f\u007f]/;

export interface HardenedCookieOptions {
  /** Defaults to `true`. */
  readonly httpOnly?: boolean;
  /** Defaults to `true`. Required for `SameSite=None`, `__Host-`, and `__Secure-`. */
  readonly secure?: boolean;
  /** Defaults to `'Lax'`. */
  readonly sameSite?: 'Strict' | 'Lax' | 'None';
  /** Defaults to `'/'`. Must be `'/'` for `__Host-` cookies. */
  readonly path?: string;
  readonly domain?: string;
  readonly maxAgeSeconds?: number;
  readonly expires?: Date;
  readonly partitioned?: boolean;
}

export function serializeHardenedCookie(
  name: string,
  value: string,
  options: HardenedCookieOptions = {},
): string {
  if (!COOKIE_NAME_RE.test(name)) {
    throw new ConfigurationError(`Invalid cookie name "${name}"`);
  }
  if (typeof value !== 'string' || CONTROL_CHAR_RE.test(value) || value.includes(';')) {
    throw new ConfigurationError(`Cookie "${name}" contains forbidden control or separator characters`);
  }

  const httpOnly = options.httpOnly ?? true;
  const secure = options.secure ?? true;
  const sameSite = options.sameSite ?? 'Lax';
  const path = options.path ?? '/';

  if (sameSite === 'None' && !secure) {
    throw new ConfigurationError('Cookie with SameSite=None must set Secure=true');
  }

  if (name.startsWith('__Secure-') && !secure) {
    throw new ConfigurationError('__Secure- prefixed cookies must set Secure=true');
  }

  if (name.startsWith('__Host-')) {
    if (!secure) {
      throw new ConfigurationError('__Host- prefixed cookies must set Secure=true');
    }
    if (options.domain !== undefined) {
      throw new ConfigurationError('__Host- prefixed cookies must not specify a Domain attribute');
    }
    if (path !== '/') {
      throw new ConfigurationError('__Host- prefixed cookies must set Path=/');
    }
  }

  if (CONTROL_CHAR_RE.test(path) || path.includes(';')) {
    throw new ConfigurationError('Cookie Path contains forbidden characters');
  }

  const parts: string[] = [`${name}=${value}`, `Path=${path}`, `SameSite=${sameSite}`];

  if (options.domain !== undefined) {
    if (CONTROL_CHAR_RE.test(options.domain) || options.domain.includes(';')) {
      throw new ConfigurationError('Cookie Domain contains forbidden characters');
    }
    parts.push(`Domain=${options.domain}`);
  }
  if (options.maxAgeSeconds !== undefined) {
    if (!Number.isInteger(options.maxAgeSeconds) || options.maxAgeSeconds < 0) {
      throw new ConfigurationError('Cookie maxAgeSeconds must be a non-negative integer');
    }
    parts.push(`Max-Age=${options.maxAgeSeconds}`);
  }
  if (options.expires !== undefined) {
    parts.push(`Expires=${options.expires.toUTCString()}`);
  }
  if (httpOnly) {
    parts.push('HttpOnly');
  }
  if (secure) {
    parts.push('Secure');
  }
  if (options.partitioned === true) {
    if (!secure) {
      throw new ConfigurationError('Partitioned cookies must set Secure=true');
    }
    parts.push('Partitioned');
  }

  return parts.join('; ');
}
