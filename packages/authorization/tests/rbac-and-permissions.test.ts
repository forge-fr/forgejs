import { describe, expect, it } from 'vitest';
import { ConfigurationError } from '@forge-fr/core';
import {
  createRbacRegistry,
  matchesPermission,
  type Actor,
} from '@forge-fr/authorization';

describe('@forge-fr/authorization RBAC & Permissions (M4.4)', () => {
  it('enforces segment-strict permission matching without prefix/substring bypasses', () => {
    expect(matchesPermission('invoice:read', 'invoice:read')).toBe(true);
    expect(matchesPermission('invoice:*', 'invoice:read')).toBe(true);
    expect(matchesPermission('invoice:*', 'invoice:delete')).toBe(true);
    expect(matchesPermission('*:read', 'invoice:read')).toBe(true);
    expect(matchesPermission('org:*:read', 'org:billing:read')).toBe(true);
    expect(matchesPermission('*', 'anything:at:all')).toBe(true);

    // SECURITY: no prefix/substring confusion or segment-count mismatch
    expect(matchesPermission('invoice:read', 'invoice:read_secret')).toBe(false);
    expect(matchesPermission('invoice:read', 'invoice:read:all')).toBe(false);
    expect(matchesPermission('invoice:*', 'invoice:nested:deep')).toBe(false);
    expect(matchesPermission('invoice:**', 'invoice:nested:deep')).toBe(true);
    expect(matchesPermission('invoice:read', '')).toBe(false);
    expect(matchesPermission('', 'invoice:read')).toBe(false);
  });

  it('resolves role inheritance with deny-overrides-allow precedence and blocks privilege escalation', () => {
    const rbac = createRbacRegistry({
      viewer: {
        permissions: ['invoice:read', 'project:read'],
      },
      editor: {
        inherits: ['viewer'],
        permissions: ['invoice:create', 'invoice:update', 'project:update'],
      },
      billing_admin: {
        inherits: ['editor'],
        permissions: ['invoice:*'],
        deniedPermissions: ['invoice:hard_delete'],
      },
      restricted_contractor: {
        inherits: ['editor'],
        permissions: ['!invoice:update'],
      },
    });

    const billingAdmin: Actor = {
      subject: 'usr_admin',
      tenantId: 'ten_1',
      roles: ['billing_admin'],
      permissions: ['invoice:hard_delete'], // Even direct allow MUST NOT bypass role explicit deny
      scopes: [],
    };

    expect(rbac.hasRole(billingAdmin, 'billing_admin')).toBe(true);
    expect(rbac.hasRole(billingAdmin, 'editor')).toBe(true);
    expect(rbac.hasRole(billingAdmin, 'viewer')).toBe(true);
    expect(rbac.hasAllRoles(billingAdmin, ['viewer', 'editor'])).toBe(true);
    expect(rbac.hasAnyRole(billingAdmin, ['super_admin', 'viewer'])).toBe(true);
    expect(rbac.hasPermission(billingAdmin, 'invoice:read')).toBe(true);
    expect(rbac.hasPermission(billingAdmin, 'invoice:refund')).toBe(true);
    // Explicit deny beats both wildcard invoice:* and direct actor allow!
    expect(rbac.hasPermission(billingAdmin, 'invoice:hard_delete')).toBe(false);

    const contractor: Actor = {
      subject: 'usr_contractor',
      tenantId: 'ten_1',
      roles: ['restricted_contractor'],
      permissions: [],
      scopes: [],
    };
    expect(rbac.hasPermission(contractor, 'invoice:read')).toBe(true);
    expect(rbac.hasPermission(contractor, 'invoice:create')).toBe(true);
    // Inline '!invoice:update' deny overrides inherited editor allow
    expect(rbac.hasPermission(contractor, 'invoice:update')).toBe(false);

    // Null/undefined actor always fails closed
    expect(rbac.hasRole(null, 'viewer')).toBe(false);
    expect(rbac.hasPermission(undefined, 'invoice:read')).toBe(false);
  });

  it('rejects circular role inheritance, unknown parent roles, and prototype-pollution keys at boot', () => {
    expect(() =>
      createRbacRegistry({
        a: { inherits: ['b'], permissions: ['x:read'] },
        b: { inherits: ['a'], permissions: ['y:read'] },
      }),
    ).toThrow(ConfigurationError);

    expect(() =>
      createRbacRegistry({
        a: { inherits: ['nonexistent'], permissions: ['x:read'] },
      }),
    ).toThrow(ConfigurationError);

    const polluted = Object.create(null) as Record<string, { permissions: string[] }>;
    polluted['__proto__'] = { permissions: ['*'] };
    expect(() => createRbacRegistry(polluted)).toThrow(ConfigurationError);

    const rbac = createRbacRegistry({
      user: { permissions: ['doc:read'] },
    });
    const maliciousActor: Actor = {
      subject: 'usr_evil',
      roles: ['constructor', 'toString', '__proto__'],
      permissions: [],
      scopes: [],
    };
    expect(rbac.hasRole(maliciousActor, 'constructor')).toBe(false);
    expect(rbac.hasPermission(maliciousActor, 'doc:read')).toBe(false);
  });
});
