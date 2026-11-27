import { ConfigurationError } from '@forge-fr/core';
import type { ForgeContext } from '@forge-fr/http';
import { constantTimeEqual, generateSecureToken, sha256Hex } from './crypto.js';
import { createAuthIdentity, type AuthIdentity, type AuthStrategy } from './types.js';

export interface ApiKeyRecord {
  readonly id: string;
  readonly prefix: string;
  readonly secretHash: string;
  readonly subject: string;
  readonly name: string;
  readonly tenantId?: string;
  readonly scopes: readonly string[];
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly createdAtMs: number;
  readonly expiresAtMs?: number;
  readonly revokedAtMs?: number;
}

export interface ApiKeyStore {
  get(id: string): Promise<ApiKeyRecord | null>;
  set(id: string, record: ApiKeyRecord): Promise<void>;
  revoke(id: string, revokedAtMs: number): Promise<void>;
}

export interface CreateApiKeyInput {
  readonly subject: string;
  readonly name: string;
  readonly tenantId?: string;
  readonly scopes?: readonly string[];
  readonly expiresInSeconds?: number;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface IssuedApiKey {
  /** Full plaintext API key — display ONCE to caller and never log or persist. */
  readonly apiKey: string;
  readonly record: ApiKeyRecord;
}

export interface ApiKeyManagerOptions {
  readonly store: ApiKeyStore;
  readonly prefix?: string;
  readonly now?: () => number;
}

export interface ApiKeyManager {
  create(input: CreateApiKeyInput): Promise<IssuedApiKey>;
  verify(rawApiKey: string): Promise<ApiKeyRecord | null>;
  revoke(id: string): Promise<void>;
}

const PREFIX_RE = /^[a-z0-9_]{2,24}$/;

export function createMemoryApiKeyStore(): ApiKeyStore {
  const records = new Map<string, ApiKeyRecord>();
  return {
    async get(id: string): Promise<ApiKeyRecord | null> {
      return records.get(id) ?? null;
    },
    async set(id: string, record: ApiKeyRecord): Promise<void> {
      records.set(id, record);
    },
    async revoke(id: string, revokedAtMs: number): Promise<void> {
      const existing = records.get(id);
      if (existing !== undefined) {
        records.set(
          id,
          Object.freeze({
            ...existing,
            revokedAtMs,
          }),
        );
      }
    },
  };
}

export function createApiKeyManager(options: ApiKeyManagerOptions): ApiKeyManager {
  const prefix = options.prefix ?? 'fjs_key';
  const now = options.now ?? (() => Date.now());

  if (!PREFIX_RE.test(prefix)) {
    throw new ConfigurationError('API key prefix must match /^[a-z0-9_]{2,24}$/');
  }

  return {
    async create(input: CreateApiKeyInput): Promise<IssuedApiKey> {
      if (typeof input.subject !== 'string' || input.subject.trim().length === 0) {
        throw new ConfigurationError('API key subject must be a non-empty string');
      }
      if (typeof input.name !== 'string' || input.name.trim().length === 0) {
        throw new ConfigurationError('API key name must be a non-empty string');
      }

      const id = generateSecureToken(12).replace(/[-_]/g, 'a').slice(0, 16);
      const rawSecret = generateSecureToken(32);
      const apiKey = `${prefix}_${id}_${rawSecret}`;
      const secretHash = await sha256Hex(rawSecret);
      const createdAtMs = now();

      const safeMeta: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
      if (input.metadata !== undefined) {
        for (const [k, v] of Object.entries(input.metadata)) {
          if (k !== '__proto__' && k !== 'constructor' && k !== 'prototype') {
            safeMeta[k] = v;
          }
        }
      }

      const record: ApiKeyRecord = Object.freeze({
        id,
        prefix,
        secretHash,
        subject: input.subject,
        name: input.name,
        ...(input.tenantId !== undefined ? { tenantId: input.tenantId } : {}),
        scopes: Object.freeze([...(input.scopes ?? [])]),
        metadata: Object.freeze(safeMeta),
        createdAtMs,
        ...(input.expiresInSeconds !== undefined
          ? { expiresAtMs: createdAtMs + input.expiresInSeconds * 1000 }
          : {}),
      });

      await options.store.set(id, record);
      return Object.freeze({ apiKey, record });
    },

    async verify(rawApiKey: string): Promise<ApiKeyRecord | null> {
      if (typeof rawApiKey !== 'string') {
        return null;
      }

      const expectedPrefix = `${prefix}_`;
      if (!rawApiKey.startsWith(expectedPrefix)) {
        return null;
      }

      const remainder = rawApiKey.slice(expectedPrefix.length);
      const sepIdx = remainder.indexOf('_');
      if (sepIdx <= 0) {
        return null;
      }

      const id = remainder.slice(0, sepIdx);
      const rawSecret = remainder.slice(sepIdx + 1);
      if (rawSecret.length < 16) {
        return null;
      }

      const record = await options.store.get(id);
      if (record === null) {
        return null;
      }

      if (record.revokedAtMs !== undefined) {
        return null;
      }

      const ts = now();
      if (record.expiresAtMs !== undefined && ts >= record.expiresAtMs) {
        return null;
      }

      const computedHash = await sha256Hex(rawSecret);
      if (!constantTimeEqual(computedHash, record.secretHash)) {
        return null;
      }

      return record;
    },

    async revoke(id: string): Promise<void> {
      await options.store.revoke(id, now());
    },
  };
}

export interface ApiKeyAuthStrategyOptions {
  readonly name?: string;
  readonly headerName?: string;
}

function extractApiKey(request: Request, headerName: string): string | null {
  const direct = request.headers.get(headerName);
  if (direct !== null && direct.trim().length > 0) {
    return direct.trim();
  }
  const authHeader = request.headers.get('authorization');
  if (authHeader !== null) {
    const match = /^ApiKey\s+([^\s]+)$/i.exec(authHeader.trim());
    if (match?.[1]) {
      return match[1];
    }
  }
  return null;
}

export function createApiKeyAuthStrategy(
  apiKeyManager: ApiKeyManager,
  options: ApiKeyAuthStrategyOptions = {},
): AuthStrategy {
  const headerName = options.headerName ?? 'x-api-key';
  return {
    name: options.name ?? 'api_key',
    async authenticate(ctx: ForgeContext): Promise<AuthIdentity | null> {
      const rawKey = extractApiKey(ctx.request, headerName);
      if (rawKey === null) {
        return null;
      }

      const record = await apiKeyManager.verify(rawKey);
      if (record === null) {
        return null;
      }

      return createAuthIdentity({
        subject: record.subject,
        method: 'api_key',
        ...(record.tenantId !== undefined ? { tenantId: record.tenantId } : {}),
        scopes: record.scopes,
        claims: {
          apiKeyId: record.id,
          apiKeyName: record.name,
          ...record.metadata,
        },
      });
    },
  };
}
