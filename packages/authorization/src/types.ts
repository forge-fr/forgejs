import type { AuthIdentity } from '@forge-fr/auth';

export interface Actor {
  readonly subject: string;
  readonly tenantId?: string;
  readonly roles: readonly string[];
  readonly permissions: readonly string[];
  readonly scopes: readonly string[];
  readonly claims?: Readonly<Record<string, unknown>>;
  readonly attributes?: Readonly<Record<string, unknown>>;
}

export type AuthorizationEffect = 'allow' | 'deny';

export interface AuthorizationDecision {
  readonly allowed: boolean;
  readonly effect: AuthorizationEffect;
  readonly reason: string;
  readonly matchedRule?: string;
}

export interface AuthorizationAuditEvent {
  readonly subject: string | null;
  readonly tenantId: string | null;
  readonly action: string;
  readonly allowed: boolean;
  readonly effect: AuthorizationEffect;
  readonly reason: string;
  readonly matchedRule?: string;
}

export type AuthorizationAuditHook = (
  event: AuthorizationAuditEvent,
) => void | Promise<void>;

export const FORBIDDEN_KEYS: ReadonlySet<string> = new Set([
  '__proto__',
  'constructor',
  'prototype',
  'toString',
  'valueOf',
]);

export function isForbiddenKey(key: string): boolean {
  return FORBIDDEN_KEYS.has(key);
}

export function isValidActor(actor: Actor | null | undefined): actor is Actor {
  return (
    actor !== null &&
    actor !== undefined &&
    typeof actor.subject === 'string' &&
    actor.subject.trim().length > 0
  );
}

export function actorFromIdentity(identity: AuthIdentity): Actor {
  return Object.freeze({
    subject: identity.subject,
    ...(identity.tenantId !== undefined ? { tenantId: identity.tenantId } : {}),
    roles: identity.roles,
    permissions: identity.permissions,
    scopes: identity.scopes,
    claims: identity.claims,
  });
}

export function createDecision(
  allowed: boolean,
  reason: string,
  matchedRule?: string,
): AuthorizationDecision {
  return Object.freeze({
    allowed,
    effect: allowed ? ('allow' as const) : ('deny' as const),
    reason,
    ...(matchedRule !== undefined ? { matchedRule } : {}),
  });
}
