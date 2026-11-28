import { describe, expect, expectTypeOf, it } from 'vitest';
import { createHttpApp } from '@forge-fr/http';
import {
  AuthIdentityKey,
  createAuthIdentity,
  createAuthMiddleware,
  getAuth,
  requireAuth,
  setAuthIdentity,
  type AuthIdentity,
} from '../src/index.js';

describe('Part 5 — @forge-fr/auth Typed AuthIdentityKey Integration', () => {
  it('propagates AuthIdentity via AuthIdentityKey with full type inference alongside getAuth/requireAuth', async () => {
    const app = createHttpApp();

    const staticStrategy = {
      name: 'static-header',
      async authenticate(ctx: { header(name: string): string | null }) {
        const userId = ctx.header('x-test-user');
        if (!userId) return null;
        return createAuthIdentity({
          subject: userId,
          method: 'custom',
          roles: ['editor'],
          permissions: ['doc:write'],
        });
      },
    };

    app.use(createAuthMiddleware({ strategies: [staticStrategy], optional: true }));

    app.get('/me', (ctx) => {
      const fromKey = ctx.get(AuthIdentityKey);
      const fromHelper = getAuth(ctx);
      const required = requireAuth(ctx);

      expectTypeOf(fromKey).toEqualTypeOf<AuthIdentity | undefined>();
      expectTypeOf(fromHelper).toEqualTypeOf<AuthIdentity | undefined>();
      expectTypeOf(required).toEqualTypeOf<AuthIdentity>();

      expect(fromKey).toBe(fromHelper);
      expect(fromKey).toBe(required);

      return ctx.json({ subject: required.subject, roles: required.roles });
    });

    app.get('/manual', (ctx) => {
      const manual = createAuthIdentity({ subject: 'manual_1', method: 'custom', roles: ['viewer'] });
      setAuthIdentity(ctx, manual);
      expect(ctx.get(AuthIdentityKey)?.subject).toBe('manual_1');
      return ctx.json({ subject: ctx.require(AuthIdentityKey).subject });
    });

    const authed = await app.fetch(
      new Request('http://localhost/me', { headers: { 'x-test-user': 'u_99' } }),
    );
    expect(authed.status).toBe(200);
    expect(await authed.json()).toEqual({ subject: 'u_99', roles: ['editor'] });

    const unauthed = await app.fetch(new Request('http://localhost/me'));
    expect(unauthed.status).toBe(401);

    const manualRes = await app.fetch(new Request('http://localhost/manual'));
    expect(manualRes.status).toBe(200);
    expect(await manualRes.json()).toEqual({ subject: 'manual_1' });
  });
});
