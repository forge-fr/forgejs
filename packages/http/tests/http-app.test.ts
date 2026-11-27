import {
  ForgeError,
  createNoopLogger,
  createToken,
  defineModule,
} from '@forge-fr/core';
import { describe, expect, it } from 'vitest';
import { BadRequestError, createHttpApp } from '../src/index.js';

describe('@forge-fr/http — Application Engine, Request-Scoped DI & Security Hardening', () => {
  it('supports simple routes, params, query parsing, 404, RFC 405 Allow, HEAD body stripping, and 204 responses', async () => {
    const app = createHttpApp({ logger: createNoopLogger() });

    app.get('/users/:id', (ctx) => {
      return ctx.json({
        id: ctx.params.id,
        role: ctx.query.role ?? 'member',
        tags: ctx.queryAll('tag'),
      });
    });

    app.post('/users', async (ctx) => {
      const payload = await ctx.body.json<{ name: string }>();
      return ctx.status(201).json({ created: payload.name });
    });

    app.delete('/users/:id', (ctx) => ctx.empty(204));

    await app.start();

    const getRes = await app.fetch(
      new Request('http://forge.local/users/u-42?role=admin&tag=a&tag=b'),
    );
    expect(getRes.status).toBe(200);
    expect(await getRes.json()).toEqual({ id: 'u-42', role: 'admin', tags: ['a', 'b'] });

    // HEAD auto-matched to GET must strip body while preserving content-type
    const headRes = await app.fetch(new Request('http://forge.local/users/u-42', { method: 'HEAD' }));
    expect(headRes.status).toBe(200);
    expect(headRes.headers.get('content-type')).toContain('application/json');
    expect(await headRes.text()).toBe('');

    // 405 Method Not Allowed includes Allow header
    const putRes = await app.fetch(new Request('http://forge.local/users/u-42', { method: 'PUT' }));
    expect(putRes.status).toBe(405);
    const allow = putRes.headers.get('allow') ?? '';
    expect(allow).toContain('GET');
    expect(allow).toContain('DELETE');

    // 404 Not Found
    const notFoundRes = await app.fetch(new Request('http://forge.local/missing'));
    expect(notFoundRes.status).toBe(404);

    // 204 No Content
    const delRes = await app.fetch(new Request('http://forge.local/users/u-42', { method: 'DELETE' }));
    expect(delRes.status).toBe(204);
    expect(await delRes.text()).toBe('');

    await app.dispose();
  });

  it('isolates request-scoped DI containers per request and always disposes them in finally (even on error)', async () => {
    const RequestTrackerToken = createToken<{ readonly id: number }>('RequestTracker');
    let seq = 0;
    const disposedIds: number[] = [];

    const app = createHttpApp({ logger: createNoopLogger() });
    app.registerProvider({
      token: RequestTrackerToken,
      scope: 'request',
      useFactory: () => ({ id: ++seq }),
      dispose: (instance) => {
        disposedIds.push(instance.id);
      },
    });

    app.get('/req-scope', (ctx) => {
      const first = ctx.resolve(RequestTrackerToken);
      const second = ctx.resolve(RequestTrackerToken);
      return ctx.json({ sameWithinRequest: first === second, id: first.id });
    });

    app.get('/req-scope-fail', (ctx) => {
      ctx.resolve(RequestTrackerToken);
      throw new Error('boom inside handler');
    });

    await app.start();

    const r1 = await app.fetch(new Request('http://forge.local/req-scope'));
    const r2 = await app.fetch(new Request('http://forge.local/req-scope'));
    const r3 = await app.fetch(new Request('http://forge.local/req-scope-fail'));

    expect(await r1.json()).toEqual({ sameWithinRequest: true, id: 1 });
    expect(await r2.json()).toEqual({ sameWithinRequest: true, id: 2 });
    expect(r3.status).toBe(500);
    expect(disposedIds).toEqual([1, 2, 3]);

    await app.dispose();
  });

  it('sanitizes internal error messages in production mode while exposing public 4xx ForgeErrors', async () => {
    const prodApp = createHttpApp({ production: true, logger: createNoopLogger() });

    prodApp.get('/internal-boom', () => {
      throw new Error('postgres://admin:supersecret@db.internal:5432/prod failed');
    });

    prodApp.get('/client-error', () => {
      throw new ForgeError('Invalid order state', {
        code: 'INVALID_ORDER_STATE',
        statusCode: 422,
        expose: true,
        details: { field: 'status' },
      });
    });

    await prodApp.start();

    const internalRes = await prodApp.fetch(new Request('http://forge.local/internal-boom'));
    expect(internalRes.status).toBe(500);
    const internalBody = (await internalRes.json()) as { error: { code: string; message: string; requestId?: string } };
    expect(internalBody.error.code).toBe('INTERNAL_ERROR');
    expect(internalBody.error.message).toBe('Internal Server Error');
    expect(JSON.stringify(internalBody)).not.toContain('supersecret');
    expect(internalBody.error.requestId).toBeTruthy();

    const clientRes = await prodApp.fetch(new Request('http://forge.local/client-error'));
    expect(clientRes.status).toBe(422);
    const clientBody = (await clientRes.json()) as {
      error: { code: string; message: string; details?: Record<string, unknown> };
    };
    expect(clientBody.error.code).toBe('INVALID_ORDER_STATE');
    expect(clientBody.error.message).toBe('Invalid order state');
    expect(clientBody.error.details).toEqual({ field: 'status' });

    await prodApp.dispose();
  });

  it('preserves multiple Set-Cookie headers, rejects CRLF header injection, and validates request IDs', async () => {
    const app = createHttpApp({
      logger: createNoopLogger(),
      trustRequestId: true,
    });

    app.get('/cookies', (ctx) => {
      ctx.appendHeader('set-cookie', 'a=1; HttpOnly; Secure; SameSite=Lax');
      ctx.appendHeader('set-cookie', 'b=2; HttpOnly; Secure; SameSite=Lax');
      return ctx.json({ requestId: ctx.requestId });
    });

    app.get('/crlf', (ctx) => {
      ctx.setHeader('x-custom', 'ok\r\nSet-Cookie: evil=1');
      return ctx.text('bad');
    });

    app.get('/redirect-crlf', (ctx) => {
      return ctx.redirect('/home\r\nX-Injected: 1');
    });

    await app.start();

    // Valid incoming x-request-id accepted when trustRequestId is true
    const cookieRes = await app.fetch(
      new Request('http://forge.local/cookies', {
        headers: { 'x-request-id': 'req-abc-123' },
      }),
    );
    expect(cookieRes.status).toBe(200);
    expect(cookieRes.headers.getSetCookie()).toEqual([
      'a=1; HttpOnly; Secure; SameSite=Lax',
      'b=2; HttpOnly; Secure; SameSite=Lax',
    ]);
    expect(cookieRes.headers.get('x-request-id')).toBe('req-abc-123');
    expect(await cookieRes.json()).toEqual({ requestId: 'req-abc-123' });

    // Unsafe incoming x-request-id rejected & regenerated
    const badReqIdRes = await app.fetch(
      new Request('http://forge.local/cookies', {
        headers: { 'x-request-id': 'bad id with spaces; <script>' },
      }),
    );
    expect(badReqIdRes.headers.get('x-request-id')).not.toContain('script');

    // CRLF header injection throws BadRequestError (400)
    const crlfRes = await app.fetch(new Request('http://forge.local/crlf'));
    expect(crlfRes.status).toBe(400);

    const redirectCrlfRes = await app.fetch(new Request('http://forge.local/redirect-crlf'));
    expect(redirectCrlfRes.status).toBe(400);
    expect(new BadRequestError('x').statusCode).toBe(400);

    await app.dispose();
  });

  it('integrates with @forge-fr/core modules and resolves exported providers in routes', async () => {
    const GreetingToken = createToken<{ greet(name: string): string }>('GreetingService');

    const GreetingModule = defineModule({
      name: 'greeting',
      providers: [
        {
          token: GreetingToken,
          useValue: { greet: (name: string) => `Hello, ${name}!` },
        },
      ],
      exports: [GreetingToken],
    });

    const app = createHttpApp({
      logger: createNoopLogger(),
      modules: [GreetingModule],
    });

    app.get('/hello/:name', (ctx) => {
      const svc = ctx.resolve(GreetingToken);
      return ctx.json({ message: svc.greet(ctx.params.name ?? 'world') });
    });

    await app.start();
    const res = await app.fetch(new Request('http://forge.local/hello/ForgeJS'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ message: 'Hello, ForgeJS!' });
    await app.dispose();
  });
});
