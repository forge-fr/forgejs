import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  ContextKeyNotFoundError,
  createContextKey,
  createHttpApp,
  isContextKey,
} from '../src/index.js';

interface AuthIdentity {
  readonly userId: string;
  readonly roles: readonly string[];
}

interface TraceSpan {
  readonly traceId: string;
  readonly sampled: boolean;
}

describe('Part 5 — Typed HttpContext State & Matched Route Pattern', () => {
  it('propagates strongly typed values from middleware to route handler without manual casting', async () => {
    const AuthIdentityKey = createContextKey<AuthIdentity>('auth.identity');
    const RequestStartKey = createContextKey<number>('req.startMs', { defaultValue: 0 });
    const OptionalSpanKey = createContextKey<TraceSpan>('trace.span');

    expect(isContextKey(AuthIdentityKey)).toBe(true);
    expect(isContextKey(RequestStartKey)).toBe(true);
    expect(isContextKey({ label: 'fake' })).toBe(false);
    expect(AuthIdentityKey.label).toBe('auth.identity');
    expect(RequestStartKey.hasDefault).toBe(true);
    expect(AuthIdentityKey.hasDefault).toBe(false);

    const app = createHttpApp();

    app.use(async (ctx, next) => {
      expect(ctx.has(AuthIdentityKey)).toBe(false);
      expect(ctx.get(AuthIdentityKey)).toBeUndefined();
      // Defaulted key resolves to its default before set()
      expect(ctx.get(RequestStartKey)).toBe(0);
      expect(ctx.has(RequestStartKey)).toBe(false);

      ctx.set(AuthIdentityKey, { userId: 'u_42', roles: ['admin'] });
      ctx.set(RequestStartKey, 1700000000);
      await next();
    });

    app.get('/users/:id', (ctx) => {
      const identity = ctx.get(AuthIdentityKey);
      const requiredIdentity = ctx.require(AuthIdentityKey);
      const startedAt = ctx.get(RequestStartKey);
      const missingSpan = ctx.get(OptionalSpanKey);

      // Compile-time type inference assertions
      expectTypeOf(identity).toEqualTypeOf<AuthIdentity | undefined>();
      expectTypeOf(requiredIdentity).toEqualTypeOf<AuthIdentity>();
      expectTypeOf(startedAt).toEqualTypeOf<number>();
      expectTypeOf(missingSpan).toEqualTypeOf<TraceSpan | undefined>();

      // @ts-expect-error — invalid value type must fail compilation
      const _wrongSet = () => ctx.set(AuthIdentityKey, { userId: 123 });
      void _wrongSet;

      // @ts-expect-error — wrong primitive assigned to defaulted numeric key
      const _wrongDefaultedSet = () => ctx.set(RequestStartKey, 'not-a-number');
      void _wrongDefaultedSet;

      return ctx.json({
        userId: requiredIdentity.userId,
        roles: requiredIdentity.roles,
        startedAt,
        hasAuth: ctx.has(AuthIdentityKey),
        hasSpan: ctx.has(OptionalSpanKey),
        routePattern: ctx.routePattern,
      });
    });

    const res = await app.fetch(new Request('http://localhost/users/99'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      userId: 'u_42',
      roles: ['admin'],
      startedAt: 1700000000,
      hasAuth: true,
      hasSpan: false,
      routePattern: '/users/:id',
    });
  });

  it('prevents collisions between distinct keys that share the exact same label', async () => {
    const KeyA = createContextKey<string>('tenant.id');
    const KeyB = createContextKey<number>('tenant.id');

    expect(KeyA.id).not.toBe(KeyB.id);

    const app = createHttpApp();
    app.use(async (ctx, next) => {
      ctx.set(KeyA, 'org_alpha');
      ctx.set(KeyB, 777);
      await next();
    });

    app.get('/collision-check', (ctx) => {
      const a = ctx.get(KeyA);
      const b = ctx.get(KeyB);
      expectTypeOf(a).toEqualTypeOf<string | undefined>();
      expectTypeOf(b).toEqualTypeOf<number | undefined>();
      return ctx.json({ a, b });
    });

    const res = await app.fetch(new Request('http://localhost/collision-check'));
    expect(await res.json()).toEqual({ a: 'org_alpha', b: 777 });
  });

  it('supports delete() and throws ContextKeyNotFoundError on ctx.require() for missing keys', async () => {
    const SessionKey = createContextKey<{ sid: string }>('auth.session');
    const CounterKey = createContextKey<number>('req.counter', { defaultValue: 1 });
    const app = createHttpApp();

    app.get('/delete-test', (ctx) => {
      ctx.set(SessionKey, { sid: 's_1' });
      expect(ctx.has(SessionKey)).toBe(true);
      expect(ctx.delete(SessionKey)).toBe(true);
      expect(ctx.delete(SessionKey)).toBe(false);
      expect(ctx.has(SessionKey)).toBe(false);
      expect(ctx.get(SessionKey)).toBeUndefined();

      // Defaulted key falls back to defaultValue after delete()
      ctx.set(CounterKey, 42);
      expect(ctx.get(CounterKey)).toBe(42);
      ctx.delete(CounterKey);
      expect(ctx.get(CounterKey)).toBe(1);
      expect(ctx.require(CounterKey)).toBe(1);

      return ctx.json({ ok: true });
    });

    let caughtError: unknown;
    app.get('/require-missing', (ctx) => {
      try {
        ctx.require(SessionKey);
      } catch (err) {
        caughtError = err;
        throw err;
      }
      return ctx.json({ ok: true });
    });

    const res1 = await app.fetch(new Request('http://localhost/delete-test'));
    expect(res1.status).toBe(200);

    const res2 = await app.fetch(new Request('http://localhost/require-missing'));
    expect(res2.status).toBe(500);
    expect(caughtError).toBeInstanceOf(ContextKeyNotFoundError);
    expect((caughtError as ContextKeyNotFoundError).code).toBe('CONTEXT_KEY_NOT_FOUND');
    expect((caughtError as ContextKeyNotFoundError).expose).toBe(false);
  });

  it('preserves backward compatibility with legacy string-based getState/setState/hasState and isolates state per request', async () => {
    const TypedKey = createContextKey<string>('shared.key');
    const app = createHttpApp();
    let seq = 0;

    app.use(async (ctx, next) => {
      seq += 1;
      ctx.set(TypedKey, `typed-${seq}`);
      ctx.setState('shared.key', `legacy-${seq}`);
      await next();
    });

    app.get('/compat', (ctx) =>
      ctx.json({
        typed: ctx.get(TypedKey),
        legacy: ctx.getState<string>('shared.key'),
        hasLegacy: ctx.hasState('shared.key'),
        routePattern: ctx.routePattern,
      }),
    );

    const [r1, r2] = await Promise.all([
      Promise.resolve(app.fetch(new Request('http://localhost/compat'))).then((r) => r.json()),
      Promise.resolve(app.fetch(new Request('http://localhost/compat'))).then((r) => r.json()),
    ]);

    expect(r1).toEqual({
      typed: 'typed-1',
      legacy: 'legacy-1',
      hasLegacy: true,
      routePattern: '/compat',
    });
    expect(r2).toEqual({
      typed: 'typed-2',
      legacy: 'legacy-2',
      hasLegacy: true,
      routePattern: '/compat',
    });
  });

  it('populates ctx.routePattern on both fast path and hooked path', async () => {
    const app = createHttpApp();
    const seenInHook: Array<string | undefined> = [];

    app.addHook('onResponse', ({ ctx }) => {
      seenInHook.push(ctx.routePattern);
    });

    app.get('/orgs/:orgId/projects/:projectId', (ctx) =>
      ctx.json({ route: ctx.routePattern, params: ctx.params }),
    );

    const res = await app.fetch(new Request('http://localhost/orgs/acme/projects/web'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      route: '/orgs/:orgId/projects/:projectId',
      params: { orgId: 'acme', projectId: 'web' },
    });
    expect(seenInHook).toEqual(['/orgs/:orgId/projects/:projectId']);
  });
});
