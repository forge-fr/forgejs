# Authorization

> Segment-strict RBAC, deny-overrides-allow ABAC policies, anti-IDOR assertOwnership(), and multi-tenant isolation checks.

- **Section**: Authentication & Security
- **Packages**: @forge-fr/authorization
- **Version**: v1.0.0-rc.1
- **Updated**: 2026-11-26
- **HTML URL**: https://github.com/forge-fr/forgejs/docs/security/authorization
- **Markdown URL**: https://github.com/forge-fr/forgejs/docs/security/authorization.md
- **Source**: https://github.com/forge-fr/forgejs/blob/main/docs/data-and-auth.md

## RBAC, ABAC policies & multi-tenant isolation

createAuthorizer() evaluates RBAC roles, explicit deniedPermissions, ABAC policies, and tenant isolation identically in both HTTP middleware and pure domain services via authorizer.forActor(actor). Deny always overrides allow.

**File: `src/authz.ts`**

```ts
import {
  assertOwnership,
  createAuthorizer,
  definePolicy,
} from '@forge-fr/authorization';

const authorizer = createAuthorizer({
  enforceTenantIsolation: true,
  roles: {
    viewer: { permissions: ['invoice:read'] },
    billingAdmin: {
      inherits: ['viewer'],
      permissions: ['invoice:*'],
      deniedPermissions: ['invoice:delete'],
    },
  },
  policies: [
    definePolicy({
      name: 'deny-suspended-actor',
      effect: 'deny',
      actions: ['*'],
      condition: ({ actor }) => actor.attributes?.['suspended'] === true,
    }),
  ],
});

const billing = authorizer.forActor({
  subject: 'u-10',
  tenantId: 'tenant-a',
  roles: ['billingAdmin'],
  permissions: [],
  scopes: [],
});

const decision = await billing.evaluate('invoice:update', { tenantId: 'tenant-a' });
assertOwnership(billing.actor, { ownerId: 'u-10' });
```
