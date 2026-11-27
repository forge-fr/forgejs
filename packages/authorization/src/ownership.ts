import { ForbiddenError, UnauthorizedError } from '@forge-fr/core';
import {
  createDecision,
  isValidActor,
  type Actor,
  type AuthorizationDecision,
} from './types.js';
import { checkTenantIsolation, type TenantScopedResource } from './tenant.js';

export interface OwnedResource extends TenantScopedResource {
  readonly ownerId?: string | null;
  readonly userId?: string | null;
  readonly createdBy?: string | null;
}

export interface OwnershipOptions<TResource = OwnedResource> {
  /** Custom extractor for resource owner subject ID. */
  readonly getOwnerId?: (resource: TResource) => string | null | undefined;
  /** Custom extractor for resource tenant ID. */
  readonly getResourceTenantId?: (resource: TResource) => string | null | undefined;
  /**
   * Enforces tenant match alongside ownership whenever a resource carries tenantId
   * (defaults to `true` to prevent cross-tenant admin IDOR).
   */
  readonly requireTenantMatch?: boolean;
  /** Roles allowed to bypass individual ownership (still tenant-scoped when requireTenantMatch is true). */
  readonly bypassRoles?: readonly string[];
  /** Explicit cross-tenant system bypass predicate. */
  readonly allowSystemBypass?: (actor: Actor) => boolean;
}

function normalizeId(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function resolveOwnerId<TResource>(
  resource: TResource,
  options?: OwnershipOptions<TResource>,
): string | null {
  if (options?.getOwnerId !== undefined) {
    return normalizeId(options.getOwnerId(resource));
  }
  if (resource !== null && typeof resource === 'object') {
    const owned = resource as OwnedResource;
    return (
      normalizeId(owned.ownerId) ??
      normalizeId(owned.userId) ??
      normalizeId(owned.createdBy)
    );
  }
  return null;
}

function hasTenantField<TResource>(
  resource: TResource,
  options?: OwnershipOptions<TResource>,
): boolean {
  if (options?.getResourceTenantId !== undefined) {
    return options.getResourceTenantId(resource) !== undefined;
  }
  return (
    resource !== null &&
    typeof resource === 'object' &&
    'tenantId' in (resource as Record<string, unknown>) &&
    (resource as TenantScopedResource).tenantId !== undefined
  );
}

export function checkOwnership<TResource = OwnedResource>(
  actor: Actor | null | undefined,
  resource: TResource | null | undefined,
  options?: OwnershipOptions<TResource>,
): AuthorizationDecision {
  if (!isValidActor(actor)) {
    return createDecision(false, 'Unauthenticated actor');
  }
  if (resource === null || resource === undefined) {
    return createDecision(false, 'Target resource is missing');
  }

  const enforceTenant = options?.requireTenantMatch ?? hasTenantField(resource, options);
  if (enforceTenant) {
    const tenantDecision = checkTenantIsolation(actor, resource, {
      ...(options?.getResourceTenantId !== undefined
        ? { getResourceTenantId: options.getResourceTenantId }
        : {}),
      ...(options?.allowSystemBypass !== undefined
        ? { allowSystemBypass: options.allowSystemBypass }
        : {}),
    });
    if (!tenantDecision.allowed) {
      return tenantDecision;
    }
  }

  if (options?.bypassRoles !== undefined && options.bypassRoles.length > 0) {
    const hasBypass = options.bypassRoles.some((role) => actor.roles.includes(role));
    if (hasBypass) {
      return createDecision(true, 'Ownership bypassed by authorized role', 'ownership:role-bypass');
    }
  }

  const ownerId = resolveOwnerId(resource, options);
  if (ownerId === null) {
    return createDecision(false, 'Resource has no owner');
  }

  if (actor.subject !== ownerId) {
    return createDecision(false, 'Actor does not own resource');
  }

  return createDecision(true, 'Resource ownership verified', 'ownership:match');
}

export function assertOwnership<TResource = OwnedResource>(
  actor: Actor | null | undefined,
  resource: TResource | null | undefined,
  options?: OwnershipOptions<TResource>,
): void {
  if (!isValidActor(actor)) {
    throw new UnauthorizedError('Authentication required');
  }

  const decision = checkOwnership(actor, resource, options);
  if (!decision.allowed) {
    throw new ForbiddenError('Access denied');
  }
}
