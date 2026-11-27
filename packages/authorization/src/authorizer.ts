import { ForbiddenError, UnauthorizedError } from '@forge-fr/core';
import {
  createRbacRegistry,
  type RbacRegistry,
  type RoleDefinitionsMap,
} from './permissions.js';
import {
  assertOwnership,
  checkOwnership,
  type OwnedResource,
  type OwnershipOptions,
} from './ownership.js';
import {
  createPolicyEngine,
  type PolicyEngine,
  type PolicyRule,
} from './policy.js';
import {
  assertTenantIsolation,
  checkTenantIsolation,
  type TenantGuardOptions,
  type TenantScopedResource,
} from './tenant.js';
import {
  isValidActor,
  type Actor,
  type AuthorizationAuditHook,
  type AuthorizationDecision,
} from './types.js';

export interface AuthorizerOptions {
  readonly roles?: RoleDefinitionsMap;
  readonly rbac?: RbacRegistry;
  readonly policies?: readonly PolicyRule<any, any>[];
  readonly enforceTenantIsolation?: boolean;
  readonly tenantOptions?: TenantGuardOptions<unknown>;
  readonly onDecision?: AuthorizationAuditHook;
}

export interface ActorAuthorizer {
  readonly actor: Actor | null | undefined;
  evaluate<TResource = unknown, TContext = unknown>(
    action: string,
    resource?: TResource,
    context?: TContext,
  ): Promise<AuthorizationDecision>;
  can<TResource = unknown, TContext = unknown>(
    action: string,
    resource?: TResource,
    context?: TContext,
  ): Promise<boolean>;
  assert<TResource = unknown, TContext = unknown>(
    action: string,
    resource?: TResource,
    context?: TContext,
  ): Promise<void>;
  hasRole(role: string): boolean;
  assertRole(role: string): void;
  hasPermission(permission: string): boolean;
  assertPermission(permission: string): void;
  assertOwner<TResource = OwnedResource>(
    resource: TResource | null | undefined,
    options?: OwnershipOptions<TResource>,
  ): void;
  assertTenant<TResource = TenantScopedResource>(
    resourceOrTenantId: TResource | string | null | undefined,
    options?: TenantGuardOptions<TResource>,
  ): void;
}

export interface Authorizer {
  readonly rbac: RbacRegistry;
  readonly policyEngine: PolicyEngine;
  evaluate<TResource = unknown, TContext = unknown>(
    actor: Actor | null | undefined,
    action: string,
    resource?: TResource,
    context?: TContext,
  ): Promise<AuthorizationDecision>;
  can<TResource = unknown, TContext = unknown>(
    actor: Actor | null | undefined,
    action: string,
    resource?: TResource,
    context?: TContext,
  ): Promise<boolean>;
  assert<TResource = unknown, TContext = unknown>(
    actor: Actor | null | undefined,
    action: string,
    resource?: TResource,
    context?: TContext,
  ): Promise<void>;
  hasRole(actor: Actor | null | undefined, role: string): boolean;
  assertRole(actor: Actor | null | undefined, role: string): void;
  hasPermission(actor: Actor | null | undefined, permission: string): boolean;
  assertPermission(actor: Actor | null | undefined, permission: string): void;
  checkOwner<TResource = OwnedResource>(
    actor: Actor | null | undefined,
    resource: TResource | null | undefined,
    options?: OwnershipOptions<TResource>,
  ): AuthorizationDecision;
  assertOwner<TResource = OwnedResource>(
    actor: Actor | null | undefined,
    resource: TResource | null | undefined,
    options?: OwnershipOptions<TResource>,
  ): void;
  checkTenant<TResource = TenantScopedResource>(
    actor: Actor | null | undefined,
    resourceOrTenantId: TResource | string | null | undefined,
    options?: TenantGuardOptions<TResource>,
  ): AuthorizationDecision;
  assertTenant<TResource = TenantScopedResource>(
    actor: Actor | null | undefined,
    resourceOrTenantId: TResource | string | null | undefined,
    options?: TenantGuardOptions<TResource>,
  ): void;
  forActor(actor: Actor | null | undefined): ActorAuthorizer;
}

export function createAuthorizer(options: AuthorizerOptions = {}): Authorizer {
  const rbac = options.rbac ?? createRbacRegistry(options.roles ?? {});
  const policyEngine = createPolicyEngine({
    rbac,
    ...(options.policies !== undefined ? { policies: options.policies } : {}),
    ...(options.enforceTenantIsolation !== undefined
      ? { enforceTenantIsolation: options.enforceTenantIsolation }
      : {}),
    ...(options.tenantOptions !== undefined ? { tenantOptions: options.tenantOptions } : {}),
    ...(options.onDecision !== undefined ? { onDecision: options.onDecision } : {}),
  });

  async function evaluate<TResource = unknown, TContext = unknown>(
    actor: Actor | null | undefined,
    action: string,
    resource?: TResource,
    context?: TContext,
  ): Promise<AuthorizationDecision> {
    return policyEngine.evaluate(actor, action, resource, context);
  }

  async function can<TResource = unknown, TContext = unknown>(
    actor: Actor | null | undefined,
    action: string,
    resource?: TResource,
    context?: TContext,
  ): Promise<boolean> {
    const decision = await evaluate(actor, action, resource, context);
    return decision.allowed;
  }

  async function assert<TResource = unknown, TContext = unknown>(
    actor: Actor | null | undefined,
    action: string,
    resource?: TResource,
    context?: TContext,
  ): Promise<void> {
    if (!isValidActor(actor)) {
      throw new UnauthorizedError('Authentication required');
    }
    const decision = await evaluate(actor, action, resource, context);
    if (!decision.allowed) {
      // Safe public message: never leak internal policy names or cross-tenant existence
      throw new ForbiddenError('Access denied');
    }
  }

  function hasRole(actor: Actor | null | undefined, role: string): boolean {
    return rbac.hasRole(actor, role);
  }

  function assertRole(actor: Actor | null | undefined, role: string): void {
    if (!isValidActor(actor)) {
      throw new UnauthorizedError('Authentication required');
    }
    if (!rbac.hasRole(actor, role)) {
      throw new ForbiddenError('Access denied');
    }
  }

  function hasPermission(actor: Actor | null | undefined, permission: string): boolean {
    return rbac.hasPermission(actor, permission);
  }

  function assertPermission(actor: Actor | null | undefined, permission: string): void {
    if (!isValidActor(actor)) {
      throw new UnauthorizedError('Authentication required');
    }
    if (!rbac.hasPermission(actor, permission)) {
      throw new ForbiddenError('Access denied');
    }
  }

  const authorizer: Authorizer = Object.freeze({
    rbac,
    policyEngine,
    evaluate,
    can,
    assert,
    hasRole,
    assertRole,
    hasPermission,
    assertPermission,
    checkOwner: checkOwnership,
    assertOwner: assertOwnership,
    checkTenant: checkTenantIsolation,
    assertTenant: assertTenantIsolation,
    forActor(actor: Actor | null | undefined): ActorAuthorizer {
      const bound: ActorAuthorizer = {
        actor,
        evaluate: (action, resource, context) => evaluate(actor, action, resource, context),
        can: (action, resource, context) => can(actor, action, resource, context),
        assert: (action, resource, context) => assert(actor, action, resource, context),
        hasRole: (role) => hasRole(actor, role),
        assertRole: (role) => assertRole(actor, role),
        hasPermission: (permission) => hasPermission(actor, permission),
        assertPermission: (permission) => assertPermission(actor, permission),
        assertOwner: (resource, opts) => assertOwnership(actor, resource, opts),
        assertTenant: (resourceOrTenantId, opts) =>
          assertTenantIsolation(actor, resourceOrTenantId, opts),
      };
      return Object.freeze(bound);
    },
  });

  return authorizer;
}
