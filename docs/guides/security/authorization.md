# Authorization

> Enforce roles (RBAC), custom rules (ABAC), record ownership checks (anti-IDOR), and multi-tenant isolation in one place.

- **Section**: Authentication & Security
- **Packages**: @forge-fr/authorization
- **Version**: v1.0.0
- **Updated**: 2026-11-27
- **HTML URL**: https://github.com/forge-fr/forgejs/docs/security/authorization
- **Markdown URL**: https://github.com/forge-fr/forgejs/docs/security/authorization.md
- **Source**: https://github.com/forge-fr/forgejs/blob/main/docs/data-and-auth.md

## Roles, custom rules & multi-tenant boundaries

createAuthorizer() evaluates roles, explicit denials, custom attribute rules, and tenant matching consistently in both HTTP routes and domain services via authorizer.forActor(actor). Any deny rule always wins over allow.

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
