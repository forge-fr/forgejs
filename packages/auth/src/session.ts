import { ConfigurationError } from '@forge-fr/core';
import type { ForgeContext } from '@forge-fr/http';
import { generateSecureToken, sha256Hex } from './crypto.js';
import { createAuthIdentity, type AuthIdentity, type AuthStrategy } from './types.js';

export type CookieSameSite = 'Strict' | 'Lax' | 'None';

export interface SessionCookieOptions {
  readonly name?: string;
  readonly httpOnly?: boolean;
  readonly secure?: boolean;
  readonly sameSite?: CookieSameSite;
  readonly path?: string;
  readonly domain?: string;
  readonly partitioned?: boolean;
  readonly maxAgeSeconds?: number;
}

export interface SessionRecord {
  readonly idHash: string;
  readonly subject: string;
  readonly tenantId?: string;
  readonly roles: readonly string[];
  readonly permissions: readonly string[];
  readonly data: Readonly<Record<string, unknown>>;
  readonly createdAtMs: number;
  readonly lastAccessedAtMs: number;
  readonly expiresAtMs: number;
  readonly absoluteExpiresAtMs: number;
}

export interface SessionStore {
  get(idHash: string): Promise<SessionRecord | null>;
  set(idHash: string, record: SessionRecord): Promise<void>;
  delete(idHash: string): Promise<void>;
  deleteBySubject?(subject: string): Promise<void>;
}

export interface SessionCreateInput {
  readonly tenantId?: string;
  readonly roles?: readonly string[];
  readonly permissions?: readonly string[];
  readonly data?: Readonly<Record<string, unknown>>;
}

export interface SessionCreateResult {
  readonly sessionId: string;
  readonly record: SessionRecord;
  readonly setCookieHeader: string;
}

export interface SessionManagerOptions {
  readonly store: SessionStore;
  /** Idle session timeout in seconds (default: 1800 = 30 min). */
  readonly idleTtlSeconds?: number;
  /** Absolute maximum session lifetime in seconds (default: 86400 = 24 hours). */
  readonly absoluteTtlSeconds?: number;
  /** Whether to extend idle expiration on each verified access (default: true). */
  readonly sliding?: boolean;
  readonly cookie?: SessionCookieOptions;
  readonly now?: () => number;
}

export interface SessionManager {
  readonly cookieName: string;
  create(subject: string, input?: SessionCreateInput): Promise<SessionCreateResult>;
  verify(sessionId: string): Promise<SessionRecord | null>;
  rotate(oldSessionId: string, updated?: SessionCreateInput): Promise<SessionCreateResult | null>;
  revoke(sessionId: string): Promise<void>;
  revokeAllForSubject(subject: string): Promise<void>;
  clearCookieHeader(): string;
}

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const COOKIE_TOKEN_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const CONTROL_CHAR_RE = /[\r\n\u0000-\u001f\u007f;]/;

export function parseCookies(cookieHeader: string | null): Record<string, string> {
  const out: Record<string, string> = Object.create(null) as Record<string, string>;
  if (!cookieHeader) {
    return out;
  }

  for (const part of cookieHeader.split(';')) {
    const eqIdx = part.indexOf('=');
    if (eqIdx <= 0) continue;
    const rawName = part.slice(0, eqIdx).trim();
    const rawValue = part.slice(eqIdx + 1).trim();
    if (rawName.length === 0 || FORBIDDEN_KEYS.has(rawName)) {
      continue;
    }
    try {
      out[rawName] = decodeURIComponent(rawValue);
    } catch {
      out[rawName] = rawValue;
    }
  }
  return out;
}

export function serializeCookie(
  name: string,
  value: string,
  options: Omit<SessionCookieOptions, 'name'> = {},
): string {
  if (!COOKIE_TOKEN_RE.test(name)) {
    throw new ConfigurationError(`Invalid cookie name "${name}"`);
  }
  if (CONTROL_CHAR_RE.test(value)) {
    throw new ConfigurationError('Cookie value contains forbidden control or delimiter characters');
  }

  const httpOnly = options.httpOnly ?? true;
  const secure = options.secure ?? true;
  const sameSite = options.sameSite ?? 'Lax';
  const path = options.path ?? '/';

  if (sameSite === 'None' && !secure) {
    throw new ConfigurationError('Cookies with SameSite=None must also set Secure=true');
  }
  if (CONTROL_CHAR_RE.test(path)) {
    throw new ConfigurationError('Cookie path contains forbidden characters');
  }

  const parts: string[] = [`${name}=${encodeURIComponent(value)}`, `Path=${path}`];

  if (options.domain !== undefined) {
    if (CONTROL_CHAR_RE.test(options.domain)) {
      throw new ConfigurationError('Cookie domain contains forbidden characters');
    }
    parts.push(`Domain=${options.domain}`);
  }
  if (options.maxAgeSeconds !== undefined) {
    parts.push(`Max-Age=${Math.max(0, Math.floor(options.maxAgeSeconds))}`);
  }
  if (httpOnly) {
    parts.push('HttpOnly');
  }
  if (secure) {
    parts.push('Secure');
  }
  parts.push(`SameSite=${sameSite}`);
  if (options.partitioned) {
    parts.push('Partitioned');
  }

  return parts.join('; ');
}

export function createMemorySessionStore(): SessionStore {
  const map = new Map<string, SessionRecord>();
  return {
    async get(idHash: string): Promise<SessionRecord | null> {
      return map.get(idHash) ?? null;
    },
    async set(idHash: string, record: SessionRecord): Promise<void> {
      map.set(idHash, record);
    },
    async delete(idHash: string): Promise<void> {
      map.delete(idHash);
    },
    async deleteBySubject(subject: string): Promise<void> {
      for (const [key, rec] of Array.from(map.entries())) {
        if (rec.subject === subject) {
          map.delete(key);
        }
      }
    },
  };
}

function sanitizeRecordData(data?: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  const clean: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  if (data !== undefined) {
    for (const [k, v] of Object.entries(data)) {
      if (!FORBIDDEN_KEYS.has(k)) {
        clean[k] = v;
      }
    }
  }
  return Object.freeze(clean);
}

export function createSessionManager(options: SessionManagerOptions): SessionManager {
  const idleTtlSeconds = options.idleTtlSeconds ?? 1800;
  const absoluteTtlSeconds = options.absoluteTtlSeconds ?? 86_400;
  const sliding = options.sliding ?? true;
  const now = options.now ?? (() => Date.now());
  const cookieName = options.cookie?.name ?? 'forge_session';

  if (idleTtlSeconds <= 0 || absoluteTtlSeconds <= 0) {
    throw new ConfigurationError('Session idleTtlSeconds and absoluteTtlSeconds must be positive');
  }
  if (idleTtlSeconds > absoluteTtlSeconds) {
    throw new ConfigurationError('Session idleTtlSeconds cannot exceed absoluteTtlSeconds');
  }

  const buildCookieHeader = (value: string, maxAgeSeconds: number): string =>
    serializeCookie(cookieName, value, {
      ...(options.cookie?.httpOnly !== undefined ? { httpOnly: options.cookie.httpOnly } : {}),
      ...(options.cookie?.secure !== undefined ? { secure: options.cookie.secure } : {}),
      ...(options.cookie?.sameSite !== undefined ? { sameSite: options.cookie.sameSite } : {}),
      ...(options.cookie?.path !== undefined ? { path: options.cookie.path } : {}),
      ...(options.cookie?.domain !== undefined ? { domain: options.cookie.domain } : {}),
      ...(options.cookie?.partitioned !== undefined
        ? { partitioned: options.cookie.partitioned }
        : {}),
      maxAgeSeconds,
    });

  return {
    cookieName,

    async create(subject: string, input: SessionCreateInput = {}): Promise<SessionCreateResult> {
      if (typeof subject !== 'string' || subject.trim().length === 0) {
        throw new ConfigurationError('Session subject must be a non-empty string');
      }

      const sessionId = generateSecureToken(32);
      const idHash = await sha256Hex(sessionId);
      const ts = now();

      const record: SessionRecord = Object.freeze({
        idHash,
        subject,
        ...(input.tenantId !== undefined ? { tenantId: input.tenantId } : {}),
        roles: Object.freeze([...(input.roles ?? [])]),
        permissions: Object.freeze([...(input.permissions ?? [])]),
        data: sanitizeRecordData(input.data),
        createdAtMs: ts,
        lastAccessedAtMs: ts,
        expiresAtMs: ts + idleTtlSeconds * 1000,
        absoluteExpiresAtMs: ts + absoluteTtlSeconds * 1000,
      });

      await options.store.set(idHash, record);

      return Object.freeze({
        sessionId,
        record,
        setCookieHeader: buildCookieHeader(sessionId, options.cookie?.maxAgeSeconds ?? idleTtlSeconds),
      });
    },

    async verify(sessionId: string): Promise<SessionRecord | null> {
      if (typeof sessionId !== 'string' || sessionId.length < 16) {
        return null;
      }

      const idHash = await sha256Hex(sessionId);
      const record = await options.store.get(idHash);
      if (record === null) {
        return null;
      }

      const ts = now();
      if (ts >= record.expiresAtMs || ts >= record.absoluteExpiresAtMs) {
        await options.store.delete(idHash);
        return null;
      }

      if (sliding) {
        const nextExpiresAtMs = Math.min(ts + idleTtlSeconds * 1000, record.absoluteExpiresAtMs);
        const updated: SessionRecord = Object.freeze({
          ...record,
          lastAccessedAtMs: ts,
          expiresAtMs: nextExpiresAtMs,
        });
        await options.store.set(idHash, updated);
        return updated;
      }

      return record;
    },

    async rotate(
      oldSessionId: string,
      updated: SessionCreateInput = {},
    ): Promise<SessionCreateResult | null> {
      const existing = await this.verify(oldSessionId);
      if (existing === null) {
        return null;
      }

      await options.store.delete(existing.idHash);

      return this.create(existing.subject, {
        ...(updated.tenantId !== undefined
          ? { tenantId: updated.tenantId }
          : existing.tenantId !== undefined
            ? { tenantId: existing.tenantId }
            : {}),
        roles: updated.roles ?? existing.roles,
        permissions: updated.permissions ?? existing.permissions,
        data: updated.data ?? existing.data,
      });
    },

    async revoke(sessionId: string): Promise<void> {
      if (typeof sessionId !== 'string' || sessionId.length === 0) {
        return;
      }
      const idHash = await sha256Hex(sessionId);
      await options.store.delete(idHash);
    },

    async revokeAllForSubject(subject: string): Promise<void> {
      if (typeof options.store.deleteBySubject === 'function') {
        await options.store.deleteBySubject(subject);
      }
    },

    clearCookieHeader(): string {
      return buildCookieHeader('', 0);
    },
  };
}

export function createSessionAuthStrategy(
  sessionManager: SessionManager,
  name = 'session',
): AuthStrategy {
  return {
    name,
    async authenticate(ctx: ForgeContext): Promise<AuthIdentity | null> {
      const cookies = parseCookies(ctx.request.headers.get('cookie'));
      const rawSessionId = cookies[sessionManager.cookieName];
      if (!rawSessionId) {
        return null;
      }

      const record = await sessionManager.verify(rawSessionId);
      if (record === null) {
        return null;
      }

      return createAuthIdentity({
        subject: record.subject,
        method: 'session',
        sessionId: record.idHash,
        ...(record.tenantId !== undefined ? { tenantId: record.tenantId } : {}),
        roles: record.roles,
        permissions: record.permissions,
        claims: record.data,
      });
    },
  };
}
