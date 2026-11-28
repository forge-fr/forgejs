import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { createKernel, type ForgeLogger } from '@forge-fr/core';
import { createHttpApp } from '@forge-fr/http';
import {
  CorrelationIdKey,
  RequestLoggerKey,
  attachObservabilityHooks,
  compileRedactPaths,
  createCorrelationIdMiddleware,
  createMemoryLogSink,
  createPinoLogger,
  createRequestLoggingMiddleware,
  parseRedactPath,
  sanitizeLogContext,
} from '../src/index.js';
import {
  EdgeObservabilityTokens,
  createEdgeLogger,
  createEdgeMemoryLogSink,
  createEdgeObservabilityPlugin,
} from '../src/edge.js';

describe('Part 7 — Structured Logger Hardening, Path Redaction & Edge Subpath', () => {
  it('redacts nested dot, bracket, and wildcard paths recursively in sanitizeLogContext and Pino logger', () => {
    expect(parseRedactPath('req.headers["x-custom-secret"]')).toEqual([
      'req',
      'headers',
      'x-custom-secret',
    ]);
    expect(parseRedactPath('users.*.profile.ssn')).toEqual([
      'users',
      '*',
      'profile',
      'ssn',
    ]);

    const compiled = compileRedactPaths([
      'user.profile.ssn',
      'req.headers["x-internal-key"]',
      'items.*.secretNote',
    ]);

    const sanitized = sanitizeLogContext(
      {
        user: { name: 'Ada', profile: { ssn: '123-45-6789', country: 'ID' } },
        req: { headers: { 'x-internal-key': 'top-secret', 'x-request-id': 'req_1' } },
        items: [
          { id: 1, secretNote: 'alpha-secret' },
          { id: 2, secretNote: 'beta-secret' },
        ],
      },
      { compiledRedactPaths: compiled },
    );

    expect(sanitized).toEqual({
      user: { name: 'Ada', profile: { ssn: '[REDACTED]', country: 'ID' } },
      req: { headers: { 'x-internal-key': '[REDACTED]', 'x-request-id': 'req_1' } },
      items: [
        { id: 1, secretNote: '[REDACTED]' },
        { id: 2, secretNote: '[REDACTED]' },
      ],
    });

    // Verify Pino logger forwards redactPaths into sanitizeLogContext
    const sink = createMemoryLogSink();
    const pinoLogger = createPinoLogger({
      level: 'info',
      destination: sink.stream,
      redactPaths: ['customer.taxId', 'records.*.pin'],
    });
    pinoLogger.info('Customer synced', {
      customer: { id: 'c_1', taxId: '99-9999999' },
      records: [{ pin: '4321', ok: true }],
    });

    const entries = sink.entries();
    expect(entries).toHaveLength(1);
    const raw = JSON.stringify(entries[0]);
    expect(raw).not.toContain('99-9999999');
    expect(raw).not.toContain('4321');
    expect(raw).toContain('[REDACTED]');
  });

  it('exposes typed CorrelationIdKey & RequestLoggerKey and logs matched routePattern + error parity in hooks', async () => {
    const sink = createMemoryLogSink();
    const logger = createPinoLogger({ level: 'info', destination: sink.stream });
    const app = createHttpApp();

    attachObservabilityHooks(app, {
      logger,
      correlation: { headerName: 'x-request-id', trustIncoming: true },
    });

    app.get('/orders/:orderId', (ctx) => {
      const correlationId = ctx.get(CorrelationIdKey);
      const reqLogger = ctx.get(RequestLoggerKey);

      expectTypeOf(correlationId).toEqualTypeOf<string | undefined>();
      expectTypeOf(reqLogger).toEqualTypeOf<ForgeLogger | undefined>();
      expect(correlationId).toBe('corr-12345');
      expect(reqLogger).toBeDefined();

      return ctx.json({ orderId: ctx.params['orderId'], correlationId });
    });

    app.get('/orders/:orderId/fail', () => {
      throw new Error('Upstream payment timeout');
    });

    const okRes = await app.fetch(
      new Request('http://localhost/orders/ord_77', {
        headers: { 'x-request-id': 'corr-12345' },
      }),
    );
    expect(okRes.status).toBe(200);
    expect(okRes.headers.get('x-request-id')).toBe('corr-12345');

    const failRes = await app.fetch(
      new Request('http://localhost/orders/ord_88/fail', {
        headers: { 'x-request-id': 'corr-err-9' },
      }),
    );
    expect(failRes.status).toBe(500);

    const entries = sink.entries();
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({
      method: 'GET',
      path: '/orders/ord_77',
      route: '/orders/:orderId',
      statusCode: 200,
      correlationId: 'corr-12345',
    });
    expect(entries[1]).toMatchObject({
      method: 'GET',
      path: '/orders/ord_88/fail',
      route: '/orders/:orderId/fail',
      statusCode: 500,
      correlationId: 'corr-err-9',
    });
    expect((entries[1]?.['err'] as { message?: string } | undefined)?.message).toBe(
      'Upstream payment timeout',
    );
  });

  it('logs matched route pattern in createRequestLoggingMiddleware too', async () => {
    const sink = createEdgeMemoryLogSink();
    const logger = createEdgeLogger({ level: 'info', writer: sink.writer });
    const app = createHttpApp();

    app.use(createCorrelationIdMiddleware());
    app.use(createRequestLoggingMiddleware({ logger }));
    app.get('/items/:slug', (ctx) => ctx.json({ slug: ctx.params['slug'] }));

    const res = await app.fetch(new Request('http://localhost/items/keyboard'));
    expect(res.status).toBe(200);

    const entries = sink.entries();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.['route']).toBe('/items/:slug');
    expect(entries[0]?.['path']).toBe('/items/keyboard');
  });

  it('provides zero-Pino Edge-safe @forge-fr/logger/edge with redaction, child loggers, and DI plugin', async () => {
    // Verify edge.ts does not import pino or node:*
    const edgeSource = await fs.readFile(
      path.resolve(import.meta.dirname, '../src/edge.ts'),
      'utf8',
    );
    expect(edgeSource).not.toMatch(/from\s+['"]pino['"]/);
    expect(edgeSource).not.toMatch(/['"]node:/);

    const sink = createEdgeMemoryLogSink();
    const edgeLogger = createEdgeLogger({
      name: 'edge-worker',
      level: 'info',
      writer: sink.writer,
      redactPaths: ['payload.cardNumber'],
    });

    edgeLogger.debug('suppressed debug');
    const child = edgeLogger.child({ requestId: 'req_edge_1', apiKey: 'secret-should-redact' });
    child.warn('Suspicious\r\nforged line', {
      payload: { cardNumber: '4111-1111', amount: 50 },
    });

    const entries = sink.entries();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      level: 'warn',
      name: 'edge-worker',
      requestId: 'req_edge_1',
      apiKey: '[REDACTED]',
      payload: { cardNumber: '[REDACTED]', amount: 50 },
    });
    expect(entries[0]?.msg).not.toContain('\n');
    expect(entries[0]?.msg).not.toContain('\r');

    // Verify Edge observability DI plugin
    const pluginSink = createEdgeMemoryLogSink();
    const kernel = createKernel({
      plugins: [
        createEdgeObservabilityPlugin({
          serviceName: 'cf-api',
          logger: { writer: pluginSink.writer },
        }),
      ],
    });
    await kernel.start();

    const resolvedLogger = kernel.container.resolve(EdgeObservabilityTokens.Logger);
    resolvedLogger.info('edge ready');
    expect(pluginSink.entries()).toHaveLength(1);
    expect(pluginSink.entries()[0]?.name).toBe('cf-api');

    const health = await kernel.health.runAll();
    expect(health.status).toBe('ok');
    expect(JSON.stringify(health)).toContain('observability:edge-logger');

    await kernel.dispose();
  });
});
