import { ConfigurationError, ForbiddenError, UnauthorizedError } from '@forge-fr/core';
import type { ForgeContext, ForgeMiddleware } from '@forge-fr/http';
import { getAuth } from '@forge-fr/auth';
import { createRbacRegistry, type RbacRegistry } from './permissions.js';
import { assertTenantParamMatch, type TenantGuardOptions } from './tenant.js';
import { actorFromIdentity, type Actor } from './types.js';
import type { Authorizer } from './authorizer.js';

const EMPTY_RBAC = createRbacRegistry();

function requireActorFromContext(ctx: ForgeContext): Actor {
  const identity = getAuth(ctx);
  if (identity === undefined) {
    throw new UnauthorizedError('Authentication required');
  }
  return actorFromIdentity(identity);
}

export interface RoleGuardOptions {
  readonly mode?: 'any' | 'all';
  readonly rbac?: RbacRegistry;
}

export function requireRoles(
  roles: readonly string[],
  options: RoleGuardOptions = {},
): ForgeMiddleware {
  if (!Array.isArray(roles) || roles.length === 0) {
    throw new ConfigurationError('requireRoles requires at least one role');
  }
  const mode = options.mode ?? 'any';
  const rbac = options.rbac ?? EMPTY_RBAC;

  return async (ctx, next) => {
    const actor = requireActorFromContext(ctx);
    const allowed =
      mode === 'all' ? rbac.hasAllRoles(actor, roles) : rbac.hasAnyRole(actor, roles);
    if (!allowed) {
      throw new ForbiddenError('Access denied');
    }
    return next();
  };
}

export interface PermissionGuardOptions {
  readonly mode?: 'any' | 'all';
  readonly rbac?: RbacRegistry;
}

export function requirePermissions(
  permissions: readonly string[],
  options: PermissionGuardOptions = {},
): ForgeMiddleware {
  if (!Array.isArray(permissions) || permissions.length === 0) {
    throw new ConfigurationError('requirePermissions requires at least one permission');
  }
  const mode = options.mode ?? 'all';
  const rbac = options.rbac ?? EMPTY_RBAC;

  return async (ctx, next) => {
    const actor = requireActorFromContext(ctx);
    const allowed =
      mode === 'any'
        ? rbac.hasAnyPermission(actor, permissions)
        : rbac.hasAllPermissions(actor, permissions);
    if (!allowed) {
      throw new ForbiddenError('Access denied');
    }
    return next();
  };
}

export function requireTenantParam(
  paramName = 'tenantId',
  options?: Omit<TenantGuardOptions<string>, 'getResourceTenantId'>,
): ForgeMiddleware {
  if (typeof paramName !== 'string' || paramName.trim().length === 0) {
    throw new ConfigurationError('requireTenantParam requires a non-empty paramName');
  }

  return async (ctx, next) => {
    const actor = requireActorFromContext(ctx);
    const requestedTenantId = ctx.params[paramName];
    assertTenantParamMatch(actor, requestedTenantId, options);
    return next();
  };
}

export interface AuthorizationMiddlewareOptions<TResource = unknown, TContext = unknown> {
  readonly action: string | ((ctx: ForgeContext) => string);
  readonly loadResource?: (
    ctx: ForgeContext,
    actor: Actor,
  ) => TResource | Promise<TResource>;
  readonly getContext?: (
    ctx: ForgeContext,
    actor: Actor,
  ) => TContext | Promise<TContext>;
  /**
   * When true (default when `loadResource` is provided), missing/undefined loaded resources
   * immediately fail closed with ForbiddenError instead of evaluating against undefined.
   */
  readonly denyIfResourceMissing?: boolean;
}

export function createAuthorizationMiddleware<TResource = unknown, TContext = unknown>(
  authorizer: Authorizer,
  options: AuthorizationMiddlewareOptions<TResource, TContext>,
): ForgeMiddleware {
  return async (ctx, next) => {
    const actor = requireActorFromContext(ctx);
    const action = typeof options.action === 'function' ? options.action(ctx) : options.action;

    let resource: TResource | undefined;
    if (options.loadResource !== undefined) {
      resource = await options.loadResource(ctx, actor);
      const denyIfMissing = options.denyIfResourceMissing ?? true;
      if (denyIfMissing && (resource === undefined || resource === null)) {
        throw new ForbiddenError('Access denied');
      }
    }

    const extraContext =
      options.getContext !== undefined ? await options.getContext(ctx, actor) : undefined;

    await authorizer.assert(actor, action, resource, extraContext);
    return next();
  };
}
