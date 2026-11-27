import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFrameworkServer } from './lib/apps.mjs';
import { detectRuntimeMetadata, median, round2, runKeepAliveLoad } from './lib/stats.mjs';
import { runMicrobenchmarks } from './suites/microbenchmarks.mjs';

const BENCH_DIR = path.dirname(fileURLToPath(import.meta.url));
const FRAMEWORKS = ['forgejs', 'hono', 'fastify'];
const COLD_START_RUNS = 5;

const HTTP_SCENARIOS = [
  {
    id: 'static_json',
    label: 'GET /json (Static JSON)',
    method: 'GET',
    path: '/json',
  },
  {
    id: 'dynamic_param_query',
    label: 'GET /users/:id/posts?limit=15 (Param + Query)',
    method: 'GET',
    path: '/users/42/posts?limit=15',
  },
  {
    id: 'middleware_5',
    label: 'GET /mw/ping (5-Middleware Chain)',
    method: 'GET',
    path: '/mw/ping',
  },
  {
    id: 'validated_post',
    label: 'POST /items (Zod JSON Validation)',
    method: 'POST',
    path: '/items',
    headers: { 'content-type': 'application/json' },
    body: { name: 'benchmark-item', count: 7 },
  },
];

async function runHttpLoadSuite(runtime) {
  // Symmetric pre-warmup of the HTTP load generator and loopback socket pool
  // so the first framework in FRAMEWORKS does not absorb cold client JIT compilation.
  for (const framework of FRAMEWORKS) {
    const server = await startFrameworkServer(framework, runtime);
    try {
      await runKeepAliveLoad({
        baseUrl: server.url,
        method: 'GET',
        requestPath: '/json',
        headers: {},
        body: undefined,
        concurrency: 24,
        warmupMs: 150,
        durationMs: 250,
      });
    } finally {
      await server.close();
    }
  }

  const results = {};
  for (const scenario of HTTP_SCENARIOS) {
    results[scenario.id] = {
      label: scenario.label,
      frameworks: {},
    };
    for (const framework of FRAMEWORKS) {
      const server = await startFrameworkServer(framework, runtime);
      try {
        const stats = await runKeepAliveLoad({
          baseUrl: server.url,
          method: scenario.method,
          requestPath: scenario.path,
          headers: scenario.headers ?? {},
          body: scenario.body,
          concurrency: 24,
          warmupMs: 600,
          durationMs: 1200,
        });
        results[scenario.id].frameworks[framework] = stats;
      } finally {
        await server.close();
      }
    }
  }
  return results;
}

function runIsolatedProbes(runtime) {
  const probePath = path.join(BENCH_DIR, 'probes/isolated-probe.mjs');
  const results = {};
  for (const framework of FRAMEWORKS) {
    const coldStarts = [];
    let lastProbe = null;
    for (let i = 0; i < COLD_START_RUNS; i += 1) {
      const child = spawnSync(process.execPath, [probePath, framework, runtime], {
        cwd: path.resolve(BENCH_DIR, '..'),
        encoding: 'utf8',
        timeout: 15_000,
      });
      if (child.status !== 0) {
        throw new Error(
          `Isolated probe failed for ${framework} on ${runtime}: ${child.stderr || child.stdout}`,
        );
      }
      const line = child.stdout
        .trim()
        .split('\n')
        .filter((entry) => entry.trim().startsWith('{'))
        .pop();
      if (!line) {
        throw new Error(`Missing JSON output from probe for ${framework}: ${child.stdout}`);
      }
      const parsed = JSON.parse(line);
      coldStarts.push(parsed.coldStartMs);
      lastProbe = parsed;
    }

    results[framework] = {
      coldStartRunsMs: coldStarts,
      coldStartMedianMs: round2(median(coldStarts)),
      coldStartMinMs: round2(Math.min(...coldStarts)),
      coldStartMaxMs: round2(Math.max(...coldStarts)),
      idleRssMb: lastProbe.idleRssMb,
      idleHeapUsedMb: lastProbe.idleHeapUsedMb,
      loadedRssMb: lastProbe.loadedRssMb,
      loadedHeapUsedMb: lastProbe.loadedHeapUsedMb,
    };
  }
  return results;
}

function formatMarkdownReport(allResults) {
  const lines = [
    '# ForgeJS — Reproducible Performance Benchmarks (Milestone 7.1)',
    '',
    'Published with zero cherry-picking under `TESTING_STRATEGY.md` Section 5: identical 24-route tables, warmup windows, keep-alive concurrency (`24`), isolated subprocess cold-start/memory probes (`5` iterations each), and exact runtime/hardware versions.',
    '',
    'How to reproduce identically:',
    '```bash',
    'node benchmarks/run-all.mjs',
    'bun benchmarks/run-all.mjs',
    '```',
    '',
  ];

  for (const runtimeKey of ['node', 'bun']) {
    const report = allResults[runtimeKey];
    if (!report) continue;
    const { metadata, microbenchmarks, httpLoad, probes } = report;
    lines.push(
      `## Runtime: ${metadata.runtime === 'node' ? `Node.js ${metadata.runtimeVersion}` : `Bun ${metadata.runtimeVersion}`}`,
      '',
      `- **OS / CPU / RAM:** ${metadata.os} · ${metadata.cpuCores} vCPU (${metadata.cpuModel}) · ${metadata.totalMemoryMb} MB`,
      `- **Versions:** ForgeJS \`${metadata.versions.forgejs}\` · Hono \`${metadata.versions.hono}\` (\`@hono/node-server ${metadata.versions.honoNodeServer}\`) · Fastify \`${metadata.versions.fastify}\` · Zod \`${metadata.versions.zod}\` · Tinybench \`${metadata.versions.tinybench}\``,
      '',
      '### 1. Live Loopback HTTP Throughput & Latency (`concurrency = 24`, `warmup = 600ms`, `duration = 1200ms`)',
      '',
      '| Scenario | Framework | req/s | Total Req | Failed | p50 (ms) | p95 (ms) | p99 (ms) |',
      '| :--- | :--- | ---: | ---: | ---: | ---: | ---: | ---: |',
    );

    for (const scenario of Object.values(httpLoad)) {
      for (const fw of FRAMEWORKS) {
        const s = scenario.frameworks[fw];
        lines.push(
          `| ${scenario.label} | **${fw}** | ${s.rps.toLocaleString('en-US')} | ${s.totalRequests.toLocaleString('en-US')} | ${s.failedRequests} | ${s.p50Ms} | ${s.p95Ms} | ${s.p99Ms} |`,
        );
      }
    }

    lines.push(
      '',
      '### 2. Cold Startup (`5` Isolated Subprocesses) & Memory Footprint',
      '',
      '| Framework | Cold Start Median (ms) | Cold Start Range (ms) | Idle RSS (MB) | Idle Heap (MB) | Loaded RSS (MB) | Loaded Heap (MB) |',
      '| :--- | ---: | ---: | ---: | ---: | ---: | ---: |',
    );
    for (const fw of FRAMEWORKS) {
      const p = probes[fw];
      lines.push(
        `| **${fw}** | ${p.coldStartMedianMs} | ${p.coldStartMinMs}–${p.coldStartMaxMs} | ${p.idleRssMb} | ${p.idleHeapUsedMb} | ${p.loadedRssMb} | ${p.loadedHeapUsedMb} |`,
      );
    }

    lines.push(
      '',
      '### 3. In-Process Microbenchmarks (`tinybench`)',
      '',
      '| Benchmark | ops/sec | Mean (ms) | p75 (ms) | p99 (ms) | Samples |',
      '| :--- | ---: | ---: | ---: | ---: | ---: |',
    );
    for (const group of [
      ...microbenchmarks.routerAndStatic,
      ...microbenchmarks.middlewareAndValidation,
      ...microbenchmarks.diAndKernel,
    ]) {
      lines.push(
        `| ${group.name} | ${group.opsPerSec.toLocaleString('en-US')} | ${group.meanMs} | ${group.p75Ms} | ${group.p99Ms} | ${group.samples} |`,
      );
    }
    lines.push('');
  }

  return lines.join('\n');
}

async function main() {
  const metadata = detectRuntimeMetadata();
  console.error(
    `Running ForgeJS M7.1 benchmark suite on ${metadata.runtime} ${metadata.runtimeVersion}...`,
  );

  const microbenchmarks = await runMicrobenchmarks();
  const httpLoad = await runHttpLoadSuite(metadata.runtime);
  const probes = runIsolatedProbes(metadata.runtime);

  const resultsJsonPath = path.join(BENCH_DIR, 'results.json');
  let combined = {};
  if (existsSync(resultsJsonPath)) {
    try {
      combined = JSON.parse(readFileSync(resultsJsonPath, 'utf8'));
    } catch {
      combined = {};
    }
  }

  combined[metadata.runtime] = {
    generatedAt: new Date().toISOString(),
    metadata,
    microbenchmarks,
    httpLoad,
    probes,
  };

  writeFileSync(resultsJsonPath, `${JSON.stringify(combined, null, 2)}\n`, 'utf8');
  writeFileSync(path.join(BENCH_DIR, 'RESULTS.md'), formatMarkdownReport(combined), 'utf8');

  console.log(
    JSON.stringify({
      runtime: metadata.runtime,
      runtimeVersion: metadata.runtimeVersion,
      httpStaticRps: {
        forgejs: httpLoad.static_json.frameworks.forgejs.rps,
        hono: httpLoad.static_json.frameworks.hono.rps,
        fastify: httpLoad.static_json.frameworks.fastify.rps,
      },
      coldStartMedianMs: {
        forgejs: probes.forgejs.coldStartMedianMs,
        hono: probes.hono.coldStartMedianMs,
        fastify: probes.fastify.coldStartMedianMs,
      },
    }),
  );
}

await main();
