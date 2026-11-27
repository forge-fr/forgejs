import { describe, expect, it } from 'vitest';
import { createHttpApp } from '@forge-fr/http';
import { createPluginTestHarness, createTestClient } from '@forge-fr/testing';
import {
  createAuthMiddleware,
  createJwtAuthStrategy,
  createJwtService,
} from '@forge-fr/auth';
import {
  AuthorizationTokens,
  createAuthorizationMiddleware,
  createAuthorizationPlugin,
  createAuthorizer,
  definePolicy,
  requirePermissions,
  requireRoles,
  requireTenantParam,
} from '@forge-fr/authorization';

interface DocumentRecord {
  readonly id: string;
  readonly type: 'document';
  readonly ownerId: string;
  readonly tenantId: string;
}

describe('@forge-fr/authorization HTTP Middleware & ForgeJS Plugin (M4.4)', () => {
  it('enforces 401 vs 403 across requireRoles, requirePermissions, requireTenantParam, and resource policy middleware', async () => {
    const jwt = createJwtService({
      algorithms: ['HS256'],
      secret: 'forgejs-authorization-http-test-secret-key-32-bytes',
      issuer: 'forge-test',
      audience: 'forge-api',
    });

    const docs = new Map<string, DocumentRecord>([
      ['doc_1', { id: 'doc_1', type: 'document', ownerId: 'usr_alice', tenantId: 'ten_1' }],
      ['doc_2', { id: 'doc_2', type: 'document', ownerId: 'usr_bob', tenantId: 'ten_1' }],
      ['doc_3', { id: 'doc_3', type: 'document', ownerId: 'usr_carol', tenantId: 'ten_2' }],
    ]);

    const authorizer = createAuthorizer({
      roles: {
        viewer: { permissions: ['document:read'] },
        admin: { inherits: ['viewer'], permissions: ['document:*'] },
      },
      enforceTenantIsolation: true,
      policies: [
        definePolicy<DocumentRecord>({
          name: 'internal-secret-owner-delete-policy',
          effect: 'allow',
          actions: ['document:delete'],
          resourceType: 'document',
          condition: ({ actor, resource }) => resource.ownerId === actor.subject,
        }),
      ],
    });

    const authMiddleware = createAuthMiddleware({
      strategies: [createJwtAuthStrategy(jwt)],
      optional: true,
    });

    const app = createHttpApp();

    app.get('/admin/stats', (ctx) => ctx.json({ ok: true }), {
      middleware: [authMiddleware, requireRoles(['admin'], { rbac: authorizer.rbac })],
    });

    app.get('/tenants/:tenantId/reports', (ctx) => ctx.json({ tenantId: ctx.params['tenantId'] }), {
      middleware: [
        authMiddleware,
        requireTenantParam('tenantId'),
        requirePermissions(['document:read'], { rbac: authorizer.rbac }),
      ],
    });

    app.delete('/documents/:id', (ctx) => ctx.json({ deleted: ctx.params['id'] }), {
      middleware: [
        authMiddleware,
        createAuthorizationMiddleware(authorizer, {
          action: 'document:delete',
          loadResource: (ctx) => docs.get(ctx.params['id'] ?? ''),
        }),
      ],
    });

    const client = createTestClient(app);

    const aliceToken = await jwt.sign(
      { tenantId: 'ten_1', roles: ['viewer'] },
      { subject: 'usr_alice' },
    );
    const adminToken = await jwt.sign(
      { tenantId: 'ten_1', roles: ['admin'] },
      { subject: 'usr_admin' },
    );

    // 1. Unauthenticated request returns 401
    const unauthRes = await client.get('/admin/stats');
    expect(unauthRes.status).toBe(401);

    // 2. Non-admin gets 403; admin gets 200
    const forbiddenAdmin = await client.get('/admin/stats', {
      headers: { authorization: `Bearer ${aliceToken}` },
    });
    expect(forbiddenAdmin.status).toBe(403);

    const okAdmin = await client.get('/admin/stats', {
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(okAdmin.status).toBe(200);

    // 3. Multi-tenant URL param guard blocks cross-tenant spoof
    const okTenant = await client.get('/tenants/ten_1/reports', {
      headers: { authorization: `Bearer ${aliceToken}` },
    });
    expect(okTenant.status).toBe(200);

    const crossTenant = await client.get('/tenants/ten_2/reports', {
      headers: { authorization: `Bearer ${aliceToken}` },
    });
    expect(crossTenant.status).toBe(403);

    // 4. Resource-level policy middleware: Alice can delete own doc_1, blocked from Bob's doc_2 (IDOR) & Carol's doc_3 (cross-tenant)
    const delOwn = await client.delete('/documents/doc_1', {
      headers: { authorization: `Bearer ${aliceToken}` },
    });
    expect(delOwn.status).toBe(200);

    const delBob = await client.delete('/documents/doc_2', {
      headers: { authorization: `Bearer ${aliceToken}` },
    });
    expect(delBob.status).toBe(403);
    // SECURITY: must not leak internal policy name in HTTP response
    expect(await delBob.text()).not.toContain('internal-secret-owner-delete-policy');

    const delCrossTenant = await client.delete('/documents/doc_3', {
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(delCrossTenant.status).toBe(403);

    await client.close();
  });

  it('registers and exports Authorizer and RbacRegistry via ForgeJS plugin DI tokens', async () => {
    const harness = createPluginTestHarness({
      plugin: createAuthorizationPlugin(),
      config: {
        roles: {
          member: { permissions: ['ticket:read'] },
          manager: { inherits: ['member'], permissions: ['ticket:approve'] },
        },
        enforceTenantIsolation: true,
      },
    });

    await harness.start();

    const authorizer = await harness.resolveExport(AuthorizationTokens.Authorizer);
    const rbac = await harness.resolveExport(AuthorizationTokens.RbacRegistry);

    const manager = {
      subject: 'usr_mgr',
      tenantId: 'ten_9',
      roles: ['manager'],
      permissions: [],
      scopes: [],
    };

    expect(rbac.hasRole(manager, 'member')).toBe(true);
    expect(await authorizer.can(manager, 'ticket:approve', { tenantId: 'ten_9' })).toBe(true);
    expect(await authorizer.can(manager, 'ticket:approve', { tenantId: 'ten_other' })).toBe(false);

    await harness.shutdown();
  });
});
