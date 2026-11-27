import { describe, expect, it } from 'vitest';
import {
  ForgeMiddlewareError,
  ResponseCommittedError,
  createHttpApp,
  type ForgeMiddleware,
} from '../src/index.js';

describe('@forge-fr/http — Deterministic Middleware Engine & Lifecycle Hooks', () => {
  it('executes middleware in deterministic tier (global → module → group → route), priority asc, and registration tie-break order', async () => {
    const trace: string[] = [];
    const app = createHttpApp({ production: false });

    const mw = (label: string): ForgeMiddleware => async (_ctx, next) => {
      trace.push(`before:${label}`);
      const res = await next();
      trace.push(`after:${label}`);
      return res;
    };

    // Intentionally register global middleware out of priority order
    app.use(mw('global:p10'), { priority: 10 });
    app.use(mw('global:p0:a'), { priority: 0 });
    app.use(mw('global:p0:b'), { priority: 0 });
    app.use(mw('global:p-5'), { priority: -5 });

    // Module-scoped middleware
    app.use(mw('module:p0'), { tier: 'module', priority: 0 });

    app.group(
      '/v1',
      (g) => {
        g.get(
          '/items',
          (ctx) => {
            trace.push('handler');
            return ctx.json({ ok: true });
          },
          { middleware: [mw('route:a'), mw('route:b')] },
        );
      },
      { middleware: [mw('group:a')] },
    );

    await app.start();
    const res = await app.fetch(new Request('http://forge.local/v1/items'));
    expect(res.status).toBe(200);
    expect(trace).toEqual([
      'before:global:p-5',
      'before:global:p0:a',
      'before:global:p0:b',
      'before:global:p10',
      'before:module:p0',
      'before:group:a',
      'before:route:a',
      'before:route:b',
      'handler',
      'after:route:b',
      'after:route:a',
      'after:group:a',
      'after:module:p0',
      'after:global:p10',
      'after:global:p0:b',
      'after:global:p0:a',
      'after:global:p-5',
    ]);
    await app.dispose();
  });

  it('guards against calling next() twice with ForgeMiddlewareError(NEXT_ALREADY_CALLED)', async () => {
    let capturedError: unknown = null;
    const app = createHttpApp({ production: false });

    app.addHook('onError', ({ error }) => {
      capturedError = error;
    });

    app.use(async (_ctx, next) => {
      await next();
      return next(); // Double next()!
    });

    app.get('/double', (ctx) => ctx.text('ok'));
    await app.start();

    const res = await app.fetch(new Request('http://forge.local/double'));
    expect(res.status).toBe(500);
    expect(capturedError).toBeInstanceOf(ForgeMiddlewareError);
    expect((capturedError as ForgeMiddlewareError).code).toBe('NEXT_ALREADY_CALLED');
    await app.dispose();
  });

  it('guards against mutating headers or status after response commit with ResponseCommittedError', async () => {
    const app = createHttpApp({ production: false });
    let mutationError: unknown = null;

    app.addHook('onResponse', ({ ctx }) => {
      try {
        ctx.setHeader('x-late', 'should-fail');
      } catch (err: unknown) {
        mutationError = err;
      }
    });

    app.get('/commit', (ctx) => ctx.text('done'));
    await app.start();

    const res = await app.fetch(new Request('http://forge.local/commit'));
    expect(res.status).toBe(200);
    expect(mutationError).toBeInstanceOf(ResponseCommittedError);
    expect((mutationError as ResponseCommittedError).code).toBe('RESPONSE_ALREADY_COMMITTED');
    await app.dispose();
  });

  it('runs all 7 HTTP lifecycle hooks in strict order and allows preSerialization & onSend transformations', async () => {
    const stages: string[] = [];
    const app = createHttpApp({ production: false });

    app.addHook('onRequest', ({ ctx }) => {
      stages.push('onRequest');
      ctx.setState('traceId', 'tr-99');
    });

    app.addHook('preValidation', () => {
      stages.push('preValidation');
    });

    app.addHook('preHandler', () => {
      stages.push('preHandler');
    });

    app.addHook('preSerialization', ({ payload }) => {
      stages.push('preSerialization');
      if (typeof payload === 'object' && payload !== null) {
        return { ...(payload as Record<string, unknown>), wrapped: true };
      }
      return payload;
    });

    app.addHook('onSend', ({ response }) => {
      stages.push('onSend');
      const headers = new Headers(response.headers);
      headers.set('x-powered-by', 'forgejs-hook');
      return new Response(response.body, { status: response.status, headers });
    });

    app.addHook('onResponse', ({ statusCode }) => {
      stages.push(`onResponse:${statusCode}`);
    });

    app.get('/hooked', (ctx) => {
      stages.push('handler');
      return { traceId: ctx.getState<string>('traceId') };
    });

    await app.start();
    const res = await app.fetch(new Request('http://forge.local/hooked'));
    expect(res.status).toBe(200);
    expect(res.headers.get('x-powered-by')).toBe('forgejs-hook');
    expect(await res.json()).toEqual({ traceId: 'tr-99', wrapped: true });
    expect(stages).toEqual([
      'onRequest',
      'preValidation',
      'preHandler',
      'handler',
      'preSerialization',
      'onSend',
      'onResponse:200',
    ]);
    await app.dispose();
  });

  it('allows middleware to short-circuit before downstream middleware or route handler executes', async () => {
    let handlerReached = false;
    const app = createHttpApp();

    app.use((ctx) => {
      if (!ctx.header('authorization')) {
        return ctx.status(401).json({ error: 'missing_auth' });
      }
      return undefined;
    });

    app.get('/secret', (ctx) => {
      handlerReached = true;
      return ctx.json({ secret: true });
    });

    await app.start();
    const res = await app.fetch(new Request('http://forge.local/secret'));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'missing_auth' });
    expect(handlerReached).toBe(false);
    await app.dispose();
  });
});
