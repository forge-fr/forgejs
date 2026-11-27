import { ForbiddenError } from '@forge-fr/core';
import { createHttpApp } from '@forge-fr/http';
import { createTestClient } from '@forge-fr/testing';
import { describe, expect, it } from 'vitest';
import {
  createCorrelationIdMiddleware,
  createMemoryLogSink,
  createPinoLogger,
  createRequestLoggingMiddleware,
  getCorrelationId,
  getRequestLogger,
} from '@forge-fr/logger';

describe('@forge-fr/logger — Correlation IDs & Structured Request Logging', () => {
  it('generates fresh correlation IDs by default, rejects untrusted/malformed headers, and propagates on error responses', async () => {
    const app = createHttpApp();
    app.use(createCorrelationIdMiddleware());
    app.get('/ping', (ctx) => ctx.json({ correlationId: getCorrelationId(ctx) }));
    app.get('/denied', () => {
      throw new ForbiddenError('Access denied');
    });

    const client = createTestClient(app);

    // By default trustIncoming is false: attacker-supplied header is ignored
    const res1 = await client.get('/ping', {
      headers: { 'x-correlation-id': 'spoofed-attacker-id' },
    });
    expect(res1.status).toBe(200);
    const body1 = (await res1.json()) as { correlationId: string };
    expect(body1.correlationId).toBeTruthy();
    expect(body1.correlationId).not.toBe('spoofed-attacker-id');
    expect(res1.headers.get('x-correlation-id')).toBe(body1.correlationId);

    // Error responses must also carry x-correlation-id
    const errRes = await client.get('/denied');
    expect(errRes.status).toBe(403);
    expect(errRes.headers.get('x-correlation-id')).toBeTruthy();

    // When trustIncoming: true, valid correlation IDs pass through while malformed/oversized ones are replaced
    const trustedApp = createHttpApp();
    trustedApp.use(createCorrelationIdMiddleware({ trustIncoming: true }));
    trustedApp.get('/echo', (ctx) => ctx.json({ id: getCorrelationId(ctx) }));
    const trustedClient = createTestClient(trustedApp);

    const validRes = await trustedClient.get('/echo', {
      headers: { 'x-correlation-id': 'trace_req-2026:abc.01' },
    });
    expect(validRes.headers.get('x-correlation-id')).toBe('trace_req-2026:abc.01');
    expect(((await validRes.json()) as { id: string }).id).toBe('trace_req-2026:abc.01');

    const invalidRes = await trustedClient.get('/echo', {
      headers: { 'x-correlation-id': 'bad id with spaces; DROP TABLE' },
    });
    const replacedId = invalidRes.headers.get('x-correlation-id');
    expect(replacedId).toBeTruthy();
    expect(replacedId).not.toContain('DROP TABLE');
  });

  it('logs structured HTTP completion entries with severity mapping, slow-request warnings, ignored paths, and sensitive header stripping', async () => {
    const sink = createMemoryLogSink();
    const logger = createPinoLogger({ level: 'debug', destination: sink.stream });

    const app = createHttpApp({ logger });
    app.use(createCorrelationIdMiddleware({ trustIncoming: true }));
    app.use(
      createRequestLoggingMiddleware({
        logger,
        ignorePaths: ['/health/live'],
        logHeaders: ['user-agent', 'authorization', 'cookie'],
        slowRequestMs: 15,
      }),
    );

    app.get('/health/live', (ctx) => ctx.json({ status: 'ok' }));
    app.get('/items', (ctx) => {
      const reqLog = getRequestLogger(ctx);
      reqLog?.info('handler business log', { count: 3 });
      return ctx.json({ ok: true });
    });
    app.get('/missing', () => {
      throw new ForbiddenError('Resource not accessible');
    });
    app.get('/slow', async (ctx) => {
      await new Promise((resolve) => setTimeout(resolve, 25));
      return ctx.json({ slow: true });
    });
    app.get('/boom', () => {
      throw new Error('unexpected internal failure');
    });

    const client = createTestClient(app);

    // Ignored path emits zero request completion logs
    await client.get('/health/live');
    expect(sink.entries()).toHaveLength(0);

    // 200 OK with sensitive headers passed
    const okRes = await client.get('/items?secretToken=do_not_log_me', {
      headers: {
        'x-correlation-id': 'corr-items-1',
        'user-agent': 'ForgeTestAgent/1.0',
        authorization: 'Bearer ultra-secret-jwt',
        cookie: 'session=secret-session-cookie',
      },
    });
    expect(okRes.status).toBe(200);

    // 403 Forbidden -> warn
    const forbiddenRes = await client.get('/missing');
    expect(forbiddenRes.status).toBe(403);

    // Slow request -> warn
    const slowRes = await client.get('/slow');
    expect(slowRes.status).toBe(200);

    // 500 error -> error
    const errRes = await client.get('/boom');
    expect(errRes.status).toBe(500);

    const allRaw = sink.lines.join('\n');
    expect(allRaw).not.toContain('ultra-secret-jwt');
    expect(allRaw).not.toContain('secret-session-cookie');
    expect(allRaw).not.toContain('do_not_log_me');

    const entries = sink.entries();
    const handlerEntry = entries.find((e) => e['msg'] === 'handler business log');
    expect(handlerEntry).toMatchObject({
      correlationId: 'corr-items-1',
      count: 3,
    });

    const completedItems = entries.find(
      (e) => e['msg'] === 'http.request.completed' && e['path'] === '/items',
    );
    expect(completedItems).toMatchObject({
      level: 'info',
      method: 'GET',
      path: '/items',
      statusCode: 200,
      correlationId: 'corr-items-1',
    });
    expect((completedItems?.['headers'] as Record<string, unknown>)?.['user-agent']).toBe(
      'ForgeTestAgent/1.0',
    );
    expect((completedItems?.['headers'] as Record<string, unknown>)?.['authorization']).toBeUndefined();
    expect((completedItems?.['headers'] as Record<string, unknown>)?.['cookie']).toBeUndefined();

    const completed403 = entries.find(
      (e) => e['msg'] === 'http.request.completed' && e['path'] === '/missing',
    );
    expect(completed403?.['level']).toBe('warn');
    expect(completed403?.['statusCode']).toBe(403);

    const completedSlow = entries.find(
      (e) => e['msg'] === 'http.request.completed' && e['path'] === '/slow',
    );
    expect(completedSlow?.['level']).toBe('warn');
    expect(completedSlow?.['slow']).toBe(true);

    const completed500 = entries.find(
      (e) => e['msg'] === 'http.request.completed' && e['path'] === '/boom',
    );
    expect(completed500?.['level']).toBe('error');
    expect(completed500?.['statusCode']).toBe(500);
  });

  it('logs unmatched 404 routes and binds correlation IDs via attachObservabilityHooks', async () => {
    const { attachObservabilityHooks } = await import('@forge-fr/logger');
    const sink = createMemoryLogSink();
    const logger = createPinoLogger({ level: 'info', destination: sink.stream });
    const app = createHttpApp({ logger });
    attachObservabilityHooks(app, {
      logger,
      correlation: { trustIncoming: true },
    });

    const client = createTestClient(app);
    const res = await client.get('/unmatched-route', {
      headers: { 'x-correlation-id': 'corr-404-hook' },
    });
    expect(res.status).toBe(404);
    expect(res.headers.get('x-correlation-id')).toBe('corr-404-hook');

    const entry = sink.entries().find((e) => e['msg'] === 'http.request.completed');
    expect(entry).toMatchObject({
      level: 'warn',
      path: '/unmatched-route',
      statusCode: 404,
      correlationId: 'corr-404-hook',
    });
  });
});
