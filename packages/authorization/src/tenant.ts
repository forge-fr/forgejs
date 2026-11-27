import { ForbiddenError, UnauthorizedError } from '@forge-fr/core';
import {
  createDecision,
  isValidActor,
  type Actor,
  type AuthorizationDecision,
} from './types.js';

export interface TenantScopedResource {
  readonly tenantId?: string | null;
}

export interface TenantGuardOptions<TResource = TenantScopedResource> {
  /** Optional explicit bypass predicate for verified cross-tenant system actors. */
  readonly allowSystemBypass?: (actor: Actor) => boolean;
  /** Custom extractor for resource tenantId (defaults to `resource.tenantId`). */
  readonly getResourceTenantId?: (resource: TResource) => string | null | undefined;
}

function normalizeTenantId(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function extractTargetTenantId<TResource>(
  resourceOrTenantId: TResource | string | null | undefined,
  options?: TenantGuardOptions<TResource>,
): string | null {
  if (typeof resourceOrTenantId === 'string') {
    return normalizeTenantId(resourceOrTenantId);
  }
  if (resourceOrTenantId === null || resourceOrTenantId === undefined) {
    return null;
  }
  if (options?.getResourceTenantId !== undefined) {
    return normalizeTenantId(options.getResourceTenantId(resourceOrTenantId));
  }
  if (typeof resourceOrTenantId === 'object') {
    return normalizeTenantId((resourceOrTenantId as TenantScopedResource).tenantId);
  }
  return null;
}

export function checkTenantIsolation<TResource = TenantScopedResource>(
  actor: Actor | null | undefined,
  resourceOrTenantId: TResource | string | null | undefined,
  options?: TenantGuardOptions<TResource>,
): AuthorizationDecision {
  if (!isValidActor(actor)) {
    return createDecision(false, 'Unauthenticated actor');
  }

  if (options?.allowSystemBypass !== undefined) {
    try {
      if (options.allowSystemBypass(actor) === true) {
        return createDecision(true, 'System cross-tenant bypass allowed', 'tenant:system-bypass');
      }
    } catch {
      return createDecision(false, 'Tenant bypass check failed');
    }
  }

  const actorTenantId = normalizeTenantId(actor.tenantId);
  if (actorTenantId === null) {
    return createDecision(false, 'Actor is missing tenant context');
  }

  const targetTenantId = extractTargetTenantId(resourceOrTenantId, options);
  if (targetTenantId === null) {
    return createDecision(false, 'Target resource is missing tenant context');
  }

  if (actorTenantId !== targetTenantId) {
    return createDecision(false, 'Cross-tenant access denied');
  }

  return createDecision(true, 'Tenant match verified', 'tenant:match');
}

export function assertTenantIsolation<TResource = TenantScopedResource>(
  actor: Actor | null | undefined,
  resourceOrTenantId: TResource | string | null | undefined,
  options?: TenantGuardOptions<TResource>,
): void {
  if (!isValidActor(actor)) {
    throw new UnauthorizedError('Authentication required');
  }

  const decision = checkTenantIsolation(actor, resourceOrTenantId, options);
  if (!decision.allowed) {
    throw new ForbiddenError('Access denied');
  }
}

export function assertTenantParamMatch(
  actor: Actor | null | undefined,
  requestedTenantId: string | null | undefined,
  options?: Omit<TenantGuardOptions<string>, 'getResourceTenantId'>,
): void {
  assertTenantIsolation(actor, requestedTenantId, options);
}
