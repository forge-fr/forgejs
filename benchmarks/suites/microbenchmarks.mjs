import { Bench } from 'tinybench';
import {
  createContainer,
  createKernel,
  createNoopLogger,
  createToken,
  defineModule,
} from '../../packages/core/dist/index.js';
import {
  createFastifyBenchmarkApp,
  createForgeBenchmarkApp,
  createForgeBenchmarkRouter,
  createHonoBenchmarkApp,
} from '../lib/apps.mjs';

function round4(value) {
  return Math.round(value * 10000) / 10000;
}

function extractBenchSummary(bench) {
  return bench.tasks.map((task) => {
    const res = task.result;
    if (!res || res.state === 'errored') {
      throw new Error(`Benchmark task "${task.name}" failed: ${String(res?.error)}`);
    }
    return {
      name: task.name,
      opsPerSec: Math.round(res.throughput.mean),
      meanMs: round4(res.latency.mean),
      p75Ms: round4(res.latency.p75),
      p99Ms: round4(res.latency.p99),
      samples: res.latency.samplesCount ?? 0,
    };
  });
}

export async function runMicrobenchmarks() {
  const forgeRouter = createForgeBenchmarkRouter();
  const forgeApp = createForgeBenchmarkApp();
  const honoApp = createHonoBenchmarkApp();
  const fastifyApp = createFastifyBenchmarkApp();
  await fastifyApp.ready();

  // 1. Direct Router & In-Process Dispatch Microbenchmarks
  const routerBench = new Bench({ warmupTime: 200, time: 500 });
  routerBench
    .add('ForgeJS Radix Router (static + dynamic + 404 match)', () => {
      forgeRouter.match('GET', '/json');
      forgeRouter.match('GET', '/users/42/posts');
      forgeRouter.match('GET', '/api/v1/tenants/acme/members/u9');
      forgeRouter.match('GET', '/does-not-exist');
    })
    .add('ForgeJS In-Process Static JSON (app.fetch)', async () => {
      const res = await forgeApp.fetch(new Request('http://localhost/json'));
      if (res.status !== 200) throw new Error('Unexpected status');
    })
    .add('Hono In-Process Static JSON (app.fetch)', async () => {
      const res = await honoApp.fetch(new Request('http://localhost/json'));
      if (res.status !== 200) throw new Error('Unexpected status');
    })
    .add('Fastify In-Process Static JSON (app.inject)', async () => {
      const res = await fastifyApp.inject({ method: 'GET', url: '/json' });
      if (res.statusCode !== 200) throw new Error('Unexpected status');
    });

  await routerBench.run();

  // 2. Middleware Chain & Param Dispatch Microbenchmarks
  const middlewareBench = new Bench({ warmupTime: 200, time: 500 });
  middlewareBench
    .add('ForgeJS 5-Middleware Chain (/mw/ping)', async () => {
      const res = await forgeApp.fetch(new Request('http://localhost/mw/ping'));
      if (res.status !== 200) throw new Error('Unexpected status');
    })
    .add('Hono 5-Middleware Chain (/mw/ping)', async () => {
      const res = await honoApp.fetch(new Request('http://localhost/mw/ping'));
      if (res.status !== 200) throw new Error('Unexpected status');
    })
    .add('Fastify 5-Hook Chain (/mw/ping)', async () => {
      const res = await fastifyApp.inject({ method: 'GET', url: '/mw/ping' });
      if (res.statusCode !== 200) throw new Error('Unexpected status');
    })
    .add('ForgeJS Zod Validated POST (/items)', async () => {
      const res = await forgeApp.fetch(
        new Request('http://localhost/items', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{"name":"widget","count":3}',
        }),
      );
      if (res.status !== 200) throw new Error('Unexpected status');
    })
    .add('Hono Zod Validated POST (/items)', async () => {
      const res = await honoApp.fetch(
        new Request('http://localhost/items', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{"name":"widget","count":3}',
        }),
      );
      if (res.status !== 200) throw new Error('Unexpected status');
    })
    .add('Fastify Zod Validated POST (/items)', async () => {
      const res = await fastifyApp.inject({
        method: 'POST',
        url: '/items',
        headers: { 'content-type': 'application/json' },
        payload: { name: 'widget', count: 3 },
      });
      if (res.statusCode !== 200) throw new Error('Unexpected status');
    });

  await middlewareBench.run();

  await fastifyApp.close();
  await forgeApp.dispose();

  // 3. ForgeJS DI & Kernel Microbenchmarks
  const SingletonToken = createToken('bench.singleton');
  const TransientToken = createToken('bench.transient');
  const RequestToken = createToken('bench.request');

  const container = createContainer();
  container.register({ token: SingletonToken, useValue: { id: 1 } });
  container.register({
    token: TransientToken,
    useFactory: (c) => ({ dep: c.resolve(SingletonToken), rand: 1 }),
    scope: 'transient',
  });
  container.register({
    token: RequestToken,
    useFactory: (c) => ({ dep: c.resolve(SingletonToken), req: true }),
    scope: 'request',
  });

  const modA = defineModule({ name: 'mod-a' });
  const modB = defineModule({ name: 'mod-b', imports: [modA] });
  const modC = defineModule({ name: 'mod-c', imports: [modB] });
  const modD = defineModule({ name: 'mod-d', imports: [modC] });
  const modE = defineModule({ name: 'mod-e', imports: [modD] });

  const diBench = new Bench({ warmupTime: 200, time: 500 });
  diBench
    .add('DI Singleton Resolve', () => {
      const val = container.resolve(SingletonToken);
      if (val.id !== 1) throw new Error('Unexpected value');
    })
    .add('DI Transient Resolve', () => {
      const val = container.resolve(TransientToken);
      if (val.rand !== 1) throw new Error('Unexpected value');
    })
    .add('DI Request Scope Create + Resolve + Dispose', async () => {
      const scope = container.createScope();
      const val = scope.resolve(RequestToken);
      if (!val.req) throw new Error('Unexpected value');
      await scope.dispose();
    })
    .add('5-Module Kernel Boot + Shutdown', async () => {
      const kernel = createKernel({
        modules: [modE],
        logger: createNoopLogger(),
      });
      await kernel.start();
      await kernel.dispose();
    });

  await diBench.run();
  await container.dispose();

  return {
    routerAndStatic: extractBenchSummary(routerBench),
    middlewareAndValidation: extractBenchSummary(middlewareBench),
    diAndKernel: extractBenchSummary(diBench),
  };
}
