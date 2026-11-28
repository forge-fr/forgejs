# Database, ORM, Authentication & Authorization

## 1. Safe Database Errors & Checksum Migrations (`@forge-fr/database`)

`@forge-fr/database` turns raw database errors into clean typed errors without exposing passwords or connection strings, and verifies SQL migrations with checksums:

```ts forge-example
import assert from 'node:assert/strict';
import {
  DatabaseUniqueViolationError,
  normalizeDatabaseError,
  redactDatabaseUrl,
} from '@forge-fr/database';

const safeUrl = redactDatabaseUrl('postgres://admin:top_secret@db.internal:5432/prod');
assert.ok(!safeUrl.includes('top_secret'));
assert.ok(safeUrl.includes('admin:[REDACTED]@db.internal:5432/prod'));

const normalized = normalizeDatabaseError({
  code: '23505',
  message: 'duplicate key value violates unique constraint',
});
assert.ok(normalized instanceof DatabaseUniqueViolationError);
assert.equal(normalized.expose, false);
```

## 2. Authentication: Argon2id Passwords, JWT & Hashed Sessions (`@forge-fr/auth`)

`@forge-fr/auth` includes OWASP Argon2id password hashing (compatible across Node.js and Bun), strict JWT verification (`jose`), and SHA-256 hashed session tokens:

```ts forge-example
import assert from 'node:assert/strict';
import { secret } from '@forge-fr/core';
import {
  createArgon2PasswordHasher,
  createJwtService,
  createMemorySessionStore,
  createSessionManager,
} from '@forge-fr/auth';

const hasher = createArgon2PasswordHasher();
const hash = await hasher.hash('CorrectHorseBattery99!');
assert.equal(await hasher.verify('CorrectHorseBattery99!', hash), true);
assert.equal(await hasher.verify('wrong-password', hash), false);

const jwt = createJwtService({
  algorithms: ['HS256'],
  secret: secret('super-secret-signing-key-at-least-32-bytes'),
  issuer: 'https://auth.forge.local',
  audience: 'forge-api',
});
const token = await jwt.sign({ sub: 'user-1', role: 'editor' }, { expiresIn: '10m' });
const verified = await jwt.verify(token);
assert.equal(verified.payload['sub'], 'user-1');

const sessions = createSessionManager({ store: createMemorySessionStore() });
const created = await sessions.create('user-1', { tenantId: 't-1' });
const loaded = await sessions.verify(created.sessionId);
assert.equal(loaded?.subject, 'user-1');
assert.notEqual(loaded?.idHash, created.sessionId);
```

## 3. Roles (RBAC), Ownership Checks & Tenant Isolation (`@forge-fr/authorization`)

Run the exact same permission rules in your domain services (`forActor`) and HTTP middleware — any explicit deny rule always overrides allow:

```ts forge-example
import assert from 'node:assert/strict';
import { createAuthorizer, definePolicy } from '@forge-fr/authorization';

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

const canUpdate = await billing.evaluate('invoice:update', { tenantId: 'tenant-a' });
assert.equal(canUpdate.allowed, true);

const explicitDeny = await billing.evaluate('invoice:delete', { tenantId: 'tenant-a' });
assert.equal(explicitDeny.allowed, false);

const crossTenant = await billing.evaluate('invoice:read', { tenantId: 'tenant-b' });
assert.equal(crossTenant.allowed, false);
```
