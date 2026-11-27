import { readFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export function median(values) {
  if (!Array.isArray(values) || values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    return sorted[mid] ?? 0;
  }
  return ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

export function percentile(sortedValues, p) {
  if (!Array.isArray(sortedValues) || sortedValues.length === 0) {
    return 0;
  }
  const clamped = Math.min(100, Math.max(0, p));
  const index = Math.min(
    sortedValues.length - 1,
    Math.max(0, Math.ceil((clamped / 100) * sortedValues.length) - 1),
  );
  return sortedValues[index] ?? 0;
}

export function round2(value) {
  return Math.round(value * 100) / 100;
}

export function detectRuntimeMetadata() {
  const pkgJson = JSON.parse(readFileSync(path.join(ROOT_DIR, 'package.json'), 'utf8'));
  const forgeCorePkg = JSON.parse(
    readFileSync(path.join(ROOT_DIR, 'packages/core/package.json'), 'utf8'),
  );
  const isBun = typeof globalThis.Bun !== 'undefined';
  const cpus = os.cpus();

  return {
    runtime: isBun ? 'bun' : 'node',
    runtimeVersion: isBun ? globalThis.Bun.version : process.version,
    os: `${os.type()} ${os.release()} (${os.arch()})`,
    cpuModel: cpus[0]?.model || 'unknown',
    cpuCores: cpus.length,
    totalMemoryMb: Math.round(os.totalmem() / (1024 * 1024)),
    versions: {
      forgejs: forgeCorePkg.version,
      hono: pkgJson.devDependencies?.hono ?? 'unknown',
      honoNodeServer: pkgJson.devDependencies?.['@hono/node-server'] ?? 'unknown',
      fastify: pkgJson.devDependencies?.fastify ?? 'unknown',
      tinybench: pkgJson.devDependencies?.tinybench ?? 'unknown',
      zod: pkgJson.dependencies?.zod ?? 'unknown',
    },
  };
}

function sendSingleKeepAliveRequest(agent, parsedUrl, method, requestPath, headers, bodyBuffer) {
  return new Promise((resolve) => {
    const startNs = process.hrtime.bigint();
    const reqHeaders = { ...headers };
    if (bodyBuffer) {
      reqHeaders['content-length'] = String(bodyBuffer.byteLength);
    }

    const req = http.request(
      {
        agent,
        hostname: parsedUrl.hostname,
        port: Number(parsedUrl.port),
        path: requestPath,
        method,
        headers: reqHeaders,
      },
      (res) => {
        res.on('data', () => {});
        res.on('end', () => {
          const elapsedMs = Number(process.hrtime.bigint() - startNs) / 1_000_000;
          resolve({
            ok: res.statusCode === 200,
            status: res.statusCode ?? 0,
            latencyMs: elapsedMs,
          });
        });
        res.on('error', () => {
          const elapsedMs = Number(process.hrtime.bigint() - startNs) / 1_000_000;
          resolve({ ok: false, status: 0, latencyMs: elapsedMs });
        });
      },
    );

    req.on('error', () => {
      const elapsedMs = Number(process.hrtime.bigint() - startNs) / 1_000_000;
      resolve({ ok: false, status: 0, latencyMs: elapsedMs });
    });

    if (bodyBuffer) {
      req.end(bodyBuffer);
    } else {
      req.end();
    }
  });
}

export async function runKeepAliveLoad({
  baseUrl,
  method = 'GET',
  requestPath,
  headers = {},
  body = undefined,
  concurrency = 24,
  warmupMs = 400,
  durationMs = 1500,
}) {
  const parsedUrl = new URL(baseUrl);
  const bodyBuffer =
    body === undefined
      ? undefined
      : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body), 'utf8');
  const agent = new http.Agent({
    keepAlive: true,
    maxSockets: concurrency,
    maxFreeSockets: concurrency,
  });

  const driveWindow = async (windowMs, record) => {
    const deadline = performance.now() + windowMs;
    const latencies = [];
    let total = 0;
    let failed = 0;

    const worker = async () => {
      while (performance.now() < deadline) {
        const result = await sendSingleKeepAliveRequest(
          agent,
          parsedUrl,
          method,
          requestPath,
          headers,
          bodyBuffer,
        );
        if (record) {
          total += 1;
          if (!result.ok) {
            failed += 1;
          }
          latencies.push(result.latencyMs);
        }
      }
    };

    const workers = Array.from({ length: concurrency }, () => worker());
    await Promise.all(workers);
    return { latencies, total, failed };
  };

  try {
    await driveWindow(warmupMs, false);
    const startMs = performance.now();
    const measured = await driveWindow(durationMs, true);
    const actualDurationMs = Math.max(1, performance.now() - startMs);

    measured.latencies.sort((a, b) => a - b);
    const sumMs = measured.latencies.reduce((acc, v) => acc + v, 0);

    return {
      concurrency,
      warmupMs,
      durationMs: round2(actualDurationMs),
      totalRequests: measured.total,
      failedRequests: measured.failed,
      rps: round2((measured.total / actualDurationMs) * 1000),
      meanMs: round2(measured.total > 0 ? sumMs / measured.total : 0),
      p50Ms: round2(percentile(measured.latencies, 50)),
      p95Ms: round2(percentile(measured.latencies, 95)),
      p99Ms: round2(percentile(measured.latencies, 99)),
    };
  } finally {
    agent.destroy();
  }
}
