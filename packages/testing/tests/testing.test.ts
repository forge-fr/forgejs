import { createNoopLogger, createToken } from '@forge-fr/core';
import { createHttpApp } from '@forge-fr/http';
import { describe, expect, it } from 'vitest';
import { MemoryAdapter, createTestClient, overrideProvider } from '../src/index.js';

describe('@forge-fr/testing — MemoryAdapter, TestClient & DI Overrides', () => {
  it('runs full HTTP lifecycle in-process via MemoryAdapter without binding any network port', async () => {
    const adapter = new MemoryAdapter();
    const app = createHttpApp({
      adapter,
      logger: createNoopLogger(),
    });

    app.get('/ping', (ctx) => ctx.json({ pong: true, ip: ctx.remoteAddress }));

    const addr = await app.listen({ port: 0 });
    expect(addr.protocol).toBe('http');
    expect(addr.url).toContain('memory.forgejs.local');
    expect(adapter.isListening).toBe(true);

    const res = await adapter.inject(new Request('http://memory.forgejs.local/ping'), {
      remoteAddress: '10.0.0.5',
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ pong: true, ip: '10.0.0.5' });

    await app.close();
    expect(adapter.isListening).toBe(false);
    await app.dispose();
  });

  it('provides ergonomic createTestClient() with query params, JSON bodies, headers, cookies, and autoStart', async () => {
    const app = createHttpApp({ logger: createNoopLogger() });

    app.post('/echo/:kind', async (ctx) => {
      const body = await ctx.body.json<{ msg: string }>();
      ctx.appendHeader('set-cookie', 'sid=xyz; HttpOnly; Secure');
      return ctx.status(201).json({
        kind: ctx.params.kind,
        filter: ctx.query.filter ?? null,
        msg: body.msg,
        agent: ctx.header('x-client'),
      });
    });

    const client = createTestClient(app);

    const res = await client.post('/echo/note', {
      query: { filter: 'recent' },
      headers: { 'x-client': 'forge-test' },
      json: { msg: 'hello world' },
    });

    expect(res.status).toBe(201);
    expect(res.ok).toBe(true);
    expect(res.setCookies()).toEqual(['sid=xyz; HttpOnly; Secure']);
    expect(await res.json()).toEqual({
      kind: 'note',
      filter: 'recent',
      msg: 'hello world',
      agent: 'forge-test',
    });

    await client.close();
  });

  it('allows overriding DI providers cleanly in tests via overrideProvider()', async () => {
    const ClockToken = createToken<() => string>('Clock');
    const app = createHttpApp({
      logger: createNoopLogger(),
      providers: [{ token: ClockToken, useValue: () => 'real-time' }],
    });

    app.get('/time', (ctx) => ctx.json({ now: ctx.resolve(ClockToken)() }));

    overrideProvider(app, {
      token: ClockToken,
      useValue: () => '2026-11-25T00:00:00.000Z',
    });

    const client = createTestClient(app);
    const res = await client.get('/time');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ now: '2026-11-25T00:00:00.000Z' });
    await client.close();
  });
});
