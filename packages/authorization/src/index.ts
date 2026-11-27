export {
  FORBIDDEN_KEYS,
  actorFromIdentity,
  createDecision,
  isForbiddenKey,
  isValidActor,
  type Actor,
  type AuthorizationAuditEvent,
  type AuthorizationAuditHook,
  type AuthorizationDecision,
  type AuthorizationEffect,
} from './types.js';

export {
  createRbacRegistry,
  matchesPermission,
  type EffectivePermissions,
  type RbacRegistry,
  type RoleDefinition,
  type RoleDefinitionsMap,
} from './permissions.js';

export {
  assertTenantIsolation,
  assertTenantParamMatch,
  checkTenantIsolation,
  type TenantGuardOptions,
  type TenantScopedResource,
} from './tenant.js';

export {
  assertOwnership,
  checkOwnership,
  type OwnedResource,
  type OwnershipOptions,
} from './ownership.js';

export {
  createPolicyEngine,
  definePolicy,
  type PolicyEngine,
  type PolicyEngineOptions,
  type PolicyEvaluationInput,
  type PolicyRule,
} from './policy.js';

export {
  createAuthorizer,
  type ActorAuthorizer,
  type Authorizer,
  type AuthorizerOptions,
} from './authorizer.js';

export {
  createAuthorizationMiddleware,
  requirePermissions,
  requireRoles,
  requireTenantParam,
  type AuthorizationMiddlewareOptions,
  type PermissionGuardOptions,
  type RoleGuardOptions,
} from './middleware.js';

export {
  AuthorizationTokens,
  createAuthorizationPlugin,
  type AuthorizationPluginConfig,
  type AuthorizationPluginOptions,
} from './plugin.js';
