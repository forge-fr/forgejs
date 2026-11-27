import type { ForgeContext } from '@forge-fr/http';

export type AuthMethod = 'session' | 'jwt' | 'api_key' | 'oauth' | 'better_auth' | (string & {});

export interface AuthIdentity {
  readonly subject: string;
  readonly method: AuthMethod;
  readonly sessionId?: string;
  readonly tenantId?: string;
  readonly roles: readonly string[];
  readonly permissions: readonly string[];
  readonly scopes: readonly string[];
  readonly claims: Readonly<Record<string, unknown>>;
}

export interface AuthIdentityInput {
  readonly subject: string;
  readonly method: AuthMethod;
  readonly sessionId?: string;
  readonly tenantId?: string;
  readonly roles?: readonly string[];
  readonly permissions?: readonly string[];
  readonly scopes?: readonly string[];
  readonly claims?: Readonly<Record<string, unknown>>;
}

export interface AuthStrategy {
  readonly name: string;
  authenticate(ctx: ForgeContext): Promise<AuthIdentity | null>;
}

export function createAuthIdentity(input: AuthIdentityInput): AuthIdentity {
  const safeClaims: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  if (input.claims !== undefined) {
    for (const [k, v] of Object.entries(input.claims)) {
      if (k !== '__proto__' && k !== 'constructor' && k !== 'prototype') {
        safeClaims[k] = v;
      }
    }
  }

  return Object.freeze({
    subject: input.subject,
    method: input.method,
    ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
    ...(input.tenantId !== undefined ? { tenantId: input.tenantId } : {}),
    roles: Object.freeze([...(input.roles ?? [])]),
    permissions: Object.freeze([...(input.permissions ?? [])]),
    scopes: Object.freeze([...(input.scopes ?? [])]),
    claims: Object.freeze(safeClaims),
  });
}
