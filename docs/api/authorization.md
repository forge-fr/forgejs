# @forge-fr/authorization

> Segment-strict RBAC, deny-overrides ABAC policy engine, anti-IDOR resource ownership guards, multi-tenant isolation checks, and service-layer actor authorizers.

- **Version**: v1.0.0-rc.1
- **Layer**: Adapter Layer
- **Category**: security
- **Tarball**: 19.2 kB (40 files)
- **Internal deps**: @forge-fr/core, @forge-fr/http, @forge-fr/auth
- **Runtime deps**: zero runtime dependencies
- **Peer deps**: none
- **HTML URL**: https://github.com/forge-fr/forgejs/api/authorization
- **Markdown URL**: https://github.com/forge-fr/forgejs/api/authorization.md

## Installation

```bash
npm install @forge-fr/authorization
```

## Plugin Metadata

- **Factory**: `createAuthorizationPlugin`
- **Tokens**: `AuthorizationTokens`
- **Health probe**: `authorization`
- **Capabilities**: `di:register`, `health:register`

## Runtime & Error Semantics

- **Runtime**: Zero third-party runtime dependencies. Supports both HTTP route guards and service-layer actor authorization.
- **Errors**: Policy evaluation is fail-closed with universal deny-overrides-allow semantics and throws ForbiddenError (403) on denials.

## Usage Example

```ts
import { createRbacRegistry, assertOwnership, actorFromIdentity } from '@forge-fr/authorization';

const rbac = createRbacRegistry({
  roles: {
    member: { permissions: ['project:read'] },
    admin: { inherits: ['member'], permissions: ['project:*'] },
  },
});
```

## Public Exports

### RBAC, ABAC Policies, Ownership & Tenant Isolation

- **Values**: `FORBIDDEN_KEYS`, `actorFromIdentity`, `createDecision`, `isForbiddenKey`, `isValidActor`, `createRbacRegistry`, `matchesPermission`, `checkTenantIsolation`, `assertTenantIsolation`, `assertTenantParamMatch`, `checkOwnership`, `assertOwnership`, `definePolicy`, `createPolicyEngine`, `createAuthorizer`
- **Types**: `Actor`, `ActorAuthorizer`, `AuthorizationAuditEvent`, `AuthorizationAuditHook`, `AuthorizationDecision`, `AuthorizationEffect`, `Authorizer`, `AuthorizerOptions`, `EffectivePermissions`, `OwnedResource`, `OwnershipOptions`, `PolicyEngine`, `PolicyEngineOptions`, `PolicyEvaluationInput`, `PolicyRule`, `RbacRegistry`, `RoleDefinition`, `RoleDefinitionsMap`, `TenantScopedResource`

### HTTP Guards & Plugin

- **Values**: `createAuthorizationMiddleware`, `requireRoles`, `requirePermissions`, `requireTenantParam`, `AuthorizationTokens`, `createAuthorizationPlugin`
- **Types**: `AuthorizationMiddlewareOptions`, `AuthorizationPluginConfig`, `AuthorizationPluginOptions`, `PermissionGuardOptions`, `RoleGuardOptions`, `TenantGuardOptions`
