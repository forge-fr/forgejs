import { startFrameworkServer } from '../lib/apps.mjs';
import { round2, runKeepAliveLoad } from '../lib/stats.mjs';

const [, , framework, runtime] = process.argv;

if (!framework || !runtime) {
  console.error('Usage: isolated-probe.mjs <forgejs|hono|fastify> <node|bun>');
  process.exit(1);
}

const bootStartNs = process.hrtime.bigint();
const server = await startFrameworkServer(framework, runtime);

try {
  const firstResponse = await fetch(`${server.url}/json`);
  if (firstResponse.status !== 200) {
    throw new Error(`Expected 200 from ${framework}, got ${firstResponse.status}`);
  }
  await firstResponse.arrayBuffer();
  const coldStartMs = Number(process.hrtime.bigint() - bootStartNs) / 1_000_000;

  if (typeof globalThis.gc === 'function') {
    globalThis.gc();
  }
  const idleMem = process.memoryUsage();

  const load = await runKeepAliveLoad({
    baseUrl: server.url,
    method: 'GET',
    requestPath: '/json',
    concurrency: 16,
    warmupMs: 250,
    durationMs: 750,
  });

  if (typeof globalThis.gc === 'function') {
    globalThis.gc();
  }
  const loadedMem = process.memoryUsage();

  console.log(
    JSON.stringify({
      framework,
      runtime,
      coldStartMs: round2(coldStartMs),
      idleRssMb: round2(idleMem.rss / (1024 * 1024)),
      idleHeapUsedMb: round2(idleMem.heapUsed / (1024 * 1024)),
      loadedRssMb: round2(loadedMem.rss / (1024 * 1024)),
      loadedHeapUsedMb: round2(loadedMem.heapUsed / (1024 * 1024)),
      probeRequests: load.totalRequests,
      probeFailed: load.failedRequests,
    }),
  );
} finally {
  await server.close();
}
