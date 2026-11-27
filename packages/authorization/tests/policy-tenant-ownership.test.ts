import { describe, expect, it } from 'vitest';
import { ForbiddenError, UnauthorizedError } from '@forge-fr/core';
import {
  assertOwnership,
  assertTenantIsolation,
  assertTenantParamMatch,
  checkOwnership,
  checkTenantIsolation,
  createAuthorizer,
  definePolicy,
  type Actor,
  type AuthorizationAuditEvent,
} from '@forge-fr/authorization';

interface Invoice {
  readonly id: string;
  readonly type: 'invoice';
  readonly ownerId: string;
  readonly tenantId: string;
  readonly status: 'draft' | 'locked';
}

describe('@forge-fr/authorization Policy Engine, Ownership (Anti-IDOR) & Multi-Tenant Guards (M4.4)', () => {
  it('blocks cross-user IDOR and cross-tenant data bleed in Layer 1/2 service checks', () => {
    const alice: Actor = {
      subject: 'usr_alice',
      tenantId: 'ten_acme',
      roles: ['member'],
      permissions: [],
      scopes: [],
    };
    const bob: Actor = {
      subject: 'usr_bob',
      tenantId: 'ten_acme',
      roles: ['member'],
      permissions: [],
      scopes: [],
    };
    const tenantAdminOtherOrg: Actor = {
      subject: 'usr_mallory',
      tenantId: 'ten_other',
      roles: ['tenant_admin'],
      permissions: [],
      scopes: [],
    };
    const tenantAdminSameOrg: Actor = {
      subject: 'usr_admin',
      tenantId: 'ten_acme',
      roles: ['tenant_admin'],
      permissions: [],
      scopes: [],
    };
    const systemService: Actor = {
      subject: 'svc_reconciler',
      roles: ['system_internal'],
      permissions: [],
      scopes: [],
    };

    const aliceInvoice: Invoice = {
      id: 'inv_1',
      type: 'invoice',
      ownerId: 'usr_alice',
      tenantId: 'ten_acme',
      status: 'draft',
    };

    // Ownership allows exact owner in same tenant
    expect(checkOwnership(alice, aliceInvoice).allowed).toBe(true);
    expect(() => assertOwnership(alice, aliceInvoice)).not.toThrow();

    // SECURITY REGRESSION (IDOR): Bob in same tenant cannot access Alice's invoice
    expect(checkOwnership(bob, aliceInvoice).allowed).toBe(false);
    expect(() => assertOwnership(bob, aliceInvoice)).toThrow(ForbiddenError);

    // SECURITY REGRESSION (Cross-tenant IDOR): tenant_admin from ten_other CANNOT bypass into ten_acme
    expect(
      checkOwnership(tenantAdminOtherOrg, aliceInvoice, { bypassRoles: ['tenant_admin'] }).allowed,
    ).toBe(false);
    expect(() =>
      assertOwnership(tenantAdminOtherOrg, aliceInvoice, { bypassRoles: ['tenant_admin'] }),
    ).toThrow(ForbiddenError);

    // Tenant admin in SAME tenant IS allowed via bypassRoles
    expect(
      checkOwnership(tenantAdminSameOrg, aliceInvoice, { bypassRoles: ['tenant_admin'] }).allowed,
    ).toBe(true);

    // Missing ownerId or unauthenticated actor fails closed
    expect(checkOwnership(alice, { ownerId: '', tenantId: 'ten_acme' }).allowed).toBe(false);
    expect(() => assertOwnership(null, aliceInvoice)).toThrow(UnauthorizedError);

    // Multi-tenant isolation guards
    expect(checkTenantIsolation(alice, aliceInvoice).allowed).toBe(true);
    expect(checkTenantIsolation(tenantAdminOtherOrg, aliceInvoice).allowed).toBe(false);
    expect(() => assertTenantIsolation(tenantAdminOtherOrg, aliceInvoice)).toThrow(ForbiddenError);
    expect(() => assertTenantIsolation(systemService, aliceInvoice)).toThrow(ForbiddenError);
    expect(
      checkTenantIsolation(systemService, aliceInvoice, {
        allowSystemBypass: (a) => a.roles.includes('system_internal'),
      }).allowed,
    ).toBe(true);

    // Spoofed route/header tenantId param check
    expect(() => assertTenantParamMatch(alice, 'ten_acme')).not.toThrow();
    expect(() => assertTenantParamMatch(alice, 'ten_other')).toThrow(ForbiddenError);
    expect(() => assertTenantParamMatch(alice, '')).toThrow(ForbiddenError);
  });

  it('enforces deny-overrides-allow policy engine, fail-closed predicate errors, and audit hooks', async () => {
    const auditEvents: AuthorizationAuditEvent[] = [];

    const authorizer = createAuthorizer({
      roles: {
        member: { permissions: ['invoice:read', 'invoice:update'] },
        admin: { inherits: ['member'], permissions: ['invoice:*'] },
      },
      enforceTenantIsolation: true,
      policies: [
        definePolicy<Invoice>({
          name: 'deny-locked-invoice-mutations',
          effect: 'deny',
          actions: ['invoice:update', 'invoice:delete'],
          resourceType: 'invoice',
          condition: ({ resource }) => resource.status === 'locked',
        }),
        definePolicy<Invoice>({
          name: 'allow-owner-draft-delete',
          effect: 'allow',
          actions: ['invoice:delete'],
          resourceType: 'invoice',
          condition: async ({ actor, resource }) =>
            resource.ownerId === actor.subject && resource.status === 'draft',
        }),
        definePolicy<Invoice>({
          name: 'buggy-policy-throws',
          effect: 'allow',
          actions: ['invoice:special'],
          resourceType: 'invoice',
          condition: () => {
            throw new Error('secret-db-connection-string-leak');
          },
        }),
      ],
      onDecision: (evt) => {
        auditEvents.push(evt);
      },
    });

    const alice: Actor = {
      subject: 'usr_alice',
      tenantId: 'ten_1',
      roles: ['member'],
      permissions: [],
      scopes: [],
    };
    const admin: Actor = {
      subject: 'usr_admin',
      tenantId: 'ten_1',
      roles: ['admin'],
      permissions: [],
      scopes: [],
    };
    const otherTenantAdmin: Actor = {
      subject: 'usr_evil_admin',
      tenantId: 'ten_2',
      roles: ['admin'],
      permissions: [],
      scopes: [],
    };

    const draftInvoice: Invoice = {
      id: 'inv_draft',
      type: 'invoice',
      ownerId: 'usr_alice',
      tenantId: 'ten_1',
      status: 'draft',
    };
    const lockedInvoice: Invoice = {
      ...draftInvoice,
      id: 'inv_locked',
      status: 'locked',
    };

    // Owner can delete own draft via policy
    expect(await authorizer.can(alice, 'invoice:delete', draftInvoice)).toBe(true);

    // Explicit deny policy blocks EVEN admin with invoice:* wildcard on locked invoice!
    const lockedDecision = await authorizer.evaluate(admin, 'invoice:update', lockedInvoice);
    expect(lockedDecision.allowed).toBe(false);
    expect(lockedDecision.effect).toBe('deny');
    expect(lockedDecision.matchedRule).toBe('deny-locked-invoice-mutations');

    // Cross-tenant admin is blocked automatically by enforceTenantIsolation!
    await expect(authorizer.assert(otherTenantAdmin, 'invoice:read', draftInvoice)).rejects.toThrow(
      ForbiddenError,
    );

    // Predicate throwing internal error MUST fail closed and NEVER leak error message
    try {
      await authorizer.assert(alice, 'invoice:special', draftInvoice);
      expect.unreachable('Should have thrown ForbiddenError');
    } catch (err) {
      expect(err).toBeInstanceOf(ForbiddenError);
      expect((err as Error).message).not.toContain('secret-db-connection-string-leak');
    }

    // Missing actor throws UnauthorizedError (401)
    await expect(authorizer.assert(null, 'invoice:read', draftInvoice)).rejects.toThrow(
      UnauthorizedError,
    );

    // Audit hook received structured events
    expect(auditEvents.length).toBeGreaterThanOrEqual(4);
    expect(auditEvents.some((e) => e.action === 'invoice:update' && !e.allowed)).toBe(true);
  });

  it('supports service-layer actor-bound authorizer (forActor) without any HTTP dependency', async () => {
    const authorizer = createAuthorizer({
      roles: {
        editor: { permissions: ['doc:read', 'doc:write'] },
      },
      enforceTenantIsolation: true,
    });

    const serviceGuard = authorizer.forActor({
      subject: 'usr_42',
      tenantId: 'ten_alpha',
      roles: ['editor'],
      permissions: [],
      scopes: [],
    });

    await expect(
      serviceGuard.assert('doc:write', { ownerId: 'usr_42', tenantId: 'ten_alpha' }),
    ).resolves.toBeUndefined();

    expect(() =>
      serviceGuard.assertOwner({ ownerId: 'usr_99', tenantId: 'ten_alpha' }),
    ).toThrow(ForbiddenError);

    expect(() =>
      serviceGuard.assertTenant({ tenantId: 'ten_beta' }),
    ).toThrow(ForbiddenError);
  });
});
