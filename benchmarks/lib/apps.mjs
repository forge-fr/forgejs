import { serve, createAdaptorServer } from '@hono/node-server';
import fastifyFactory from 'fastify';
import { Hono } from 'hono';
import { z } from 'zod';
import { createBunAdapter } from '../../packages/bun/dist/index.js';
import { createNoopLogger } from '../../packages/core/dist/index.js';
import { createHttpApp } from '../../packages/http/dist/index.js';
import { createNodeAdapter } from '../../packages/node/dist/index.js';
import { createRouter } from '../../packages/router/dist/index.js';
import { validatedHandler } from '../../packages/validation/dist/index.js';

export const BENCHMARK_FILLER_ROUTES = [
  ['GET', '/health'],
  ['GET', '/version'],
  ['GET', '/metrics'],
  ['GET', '/api/v1/status'],
  ['GET', '/api/v1/catalog'],
  ['GET', '/api/v1/catalog/:category'],
  ['GET', '/api/v1/orders'],
  ['GET', '/api/v1/orders/:orderId'],
  ['POST', '/api/v1/orders'],
  ['GET', '/api/v1/products/:productId/reviews'],
  ['GET', '/api/v1/tenants/:tenantId/settings'],
  ['GET', '/api/v1/tenants/:tenantId/members/:memberId'],
  ['GET', '/api/v1/reports/daily'],
  ['GET', '/api/v1/reports/monthly'],
  ['GET', '/api/v1/billing/invoices/:invoiceId'],
  ['GET', '/api/v1/notifications'],
  ['GET', '/api/v1/audit/events'],
  ['GET', '/api/v1/webhooks/:webhookId'],
];

const ItemBodySchema = z.object({
  name: z.string().min(1),
  count: z.number().int().nonnegative(),
});

export function createForgeBenchmarkRouter() {
  const router = createRouter();
  for (const [method, routePath] of BENCHMARK_FILLER_ROUTES) {
    router.add(method, routePath, { tag: routePath });
  }
  router.add('GET', '/json', { tag: 'json' });
  router.add('GET', '/users/:id/posts', { tag: 'users-posts' });
  router.add('GET', '/mw/ping', { tag: 'mw-ping' });
  router.add('POST', '/items', { tag: 'items-create' });
  return router;
}

export function createForgeBenchmarkApp(options = {}) {
  const app = createHttpApp({
    logger: createNoopLogger(),
    ...(options.adapter ? { adapter: options.adapter } : {}),
  });

  for (const [method, routePath] of BENCHMARK_FILLER_ROUTES) {
    if (method === 'POST') {
      app.post(routePath, (ctx) => ctx.json({ route: routePath }));
    } else {
      app.get(routePath, (ctx) => ctx.json({ route: routePath }));
    }
  }

  app.get('/json', (ctx) => ctx.json({ ok: true, framework: 'forgejs' }));

  app.get('/users/:id/posts', (ctx) =>
    ctx.json({
      framework: 'forgejs',
      userId: ctx.params['id'] ?? '',
      limit: ctx.query['limit'] ?? '10',
    }),
  );

  const mwChain = Array.from({ length: 5 }, () => (ctx, next) => {
    const current = Number(ctx.getState('layers') ?? 0);
    ctx.setState('layers', current + 1);
    return next();
  });

  app.group(
    '/mw',
    (group) => {
      group.get('/ping', (ctx) =>
        ctx.json({
          framework: 'forgejs',
          layers: Number(ctx.getState('layers') ?? 0),
        }),
      );
    },
    { middleware: mwChain },
  );

  app.post(
    '/items',
    validatedHandler({ body: ItemBodySchema }, (ctx, validated) =>
      ctx.json({
        ok: true,
        framework: 'forgejs',
        item: validated.body,
      }),
    ),
  );

  return app;
}

export function createHonoBenchmarkApp() {
  const app = new Hono();

  for (const [method, routePath] of BENCHMARK_FILLER_ROUTES) {
    app.on(method, routePath, (c) => c.json({ route: routePath }));
  }

  app.get('/json', (c) => c.json({ ok: true, framework: 'hono' }));

  app.get('/users/:id/posts', (c) =>
    c.json({
      framework: 'hono',
      userId: c.req.param('id'),
      limit: c.req.query('limit') ?? '10',
    }),
  );

  for (let i = 0; i < 5; i += 1) {
    app.use('/mw/*', async (c, next) => {
      const current = Number(c.get('layers') ?? 0);
      c.set('layers', current + 1);
      await next();
    });
  }

  app.get('/mw/ping', (c) =>
    c.json({
      framework: 'hono',
      layers: Number(c.get('layers') ?? 0),
    }),
  );

  app.post('/items', async (c) => {
    const raw = await c.req.json();
    const parsed = ItemBodySchema.safeParse(raw);
    if (!parsed.success) {
      return c.json({ ok: false, error: 'Validation failed' }, 400);
    }
    return c.json({
      ok: true,
      framework: 'hono',
      item: parsed.data,
    });
  });

  return app;
}

export function createFastifyBenchmarkApp() {
  const app = fastifyFactory({ logger: false });

  for (const [method, routePath] of BENCHMARK_FILLER_ROUTES) {
    app.route({
      method,
      url: routePath,
      handler: async () => ({ route: routePath }),
    });
  }

  app.get('/json', async () => ({ ok: true, framework: 'fastify' }));

  app.get('/users/:id/posts', async (request) => ({
    framework: 'fastify',
    userId: request.params.id,
    limit: request.query.limit ?? '10',
  }));

  app.register(async function mwScope(instance) {
    for (let i = 0; i < 5; i += 1) {
      instance.addHook('onRequest', async (request) => {
        request.forgeLayers = (request.forgeLayers ?? 0) + 1;
      });
    }
    instance.get('/ping', async (request) => ({
      framework: 'fastify',
      layers: request.forgeLayers ?? 0,
    }));
  }, { prefix: '/mw' });

  app.post('/items', async (request, reply) => {
    const parsed = ItemBodySchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return { ok: false, error: 'Validation failed' };
    }
    return {
      ok: true,
      framework: 'fastify',
      item: parsed.data,
    };
  });

  return app;
}

export async function startFrameworkServer(framework, runtime) {
  if (framework === 'forgejs') {
    const adapter = runtime === 'bun' ? createBunAdapter() : createNodeAdapter();
    const app = createForgeBenchmarkApp({ adapter });
    const addr = await app.listen({ host: '127.0.0.1', port: 0 });
    return {
      url: addr.url,
      close: () => app.close(2000),
    };
  }

  if (framework === 'hono') {
    const app = createHonoBenchmarkApp();
    if (runtime === 'bun') {
      const server = globalThis.Bun.serve({
        hostname: '127.0.0.1',
        port: 0,
        fetch: app.fetch,
      });
      return {
        url: `http://127.0.0.1:${server.port}`,
        close: async () => {
          await server.stop(true);
        },
      };
    }

    const nodeServer = createAdaptorServer({ fetch: app.fetch });
    const port = await new Promise((resolve, reject) => {
      nodeServer.once('error', reject);
      nodeServer.listen(0, '127.0.0.1', () => {
        const address = nodeServer.address();
        if (address && typeof address === 'object') {
          resolve(address.port);
        } else {
          reject(new Error('Failed to bind Hono node server'));
        }
      });
    });
    return {
      url: `http://127.0.0.1:${port}`,
      close: () =>
        new Promise((resolve) => {
          nodeServer.close(() => resolve());
        }),
    };
  }

  if (framework === 'fastify') {
    const app = createFastifyBenchmarkApp();
    const url = await app.listen({ host: '127.0.0.1', port: 0 });
    return {
      url,
      close: () => app.close(),
    };
  }

  throw new Error(`Unsupported benchmark framework: ${framework}`);
}

export { serve };
