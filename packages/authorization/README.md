# @forge-fr/authorization

Fail-closed authorization primitives for ForgeJS: RBAC with inheritance cycle detection, segment-strict permissions with deny-overrides-allow precedence, async policy engine, resource ownership (anti-IDOR) checks, multi-tenant isolation guards, HTTP route middleware, and ForgeJS DI plugin.

Enforceable identically inside Layer 1/2 application services and HTTP route boundaries across Node.js and Bun.

## Key Capabilities

- **RBAC & Granular Permissions:** `createRbacRegistry()`, segment-strict wildcard matching (`invoice:*`, `*:read`, `*`), explicit deny rules (`!invoice:delete`) that always override allow, and startup role-inheritance cycle detection.
- **Policy Engine:** `definePolicy()`, `createPolicyEngine()`, deny-overrides-allow evaluation, fail-closed predicate exception handling, and structured `onDecision` audit hooks.
- **Ownership & Multi-Tenant Guards:** `checkOwnership()`, `assertOwnership()`, `checkTenantIsolation()`, `assertTenantIsolation()`, `assertTenantParamMatch()` blocking cross-user IDOR and cross-tenant data access.
- **Unified Service & HTTP Authorizer:** `createAuthorizer()`, `authorizer.forActor(actor)` for service boundaries, plus `requireRoles()`, `requirePermissions()`, `requireTenantParam()`, `createAuthorizationMiddleware()`, and `createAuthorizationPlugin()`.
