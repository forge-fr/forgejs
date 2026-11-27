# Infrastructure Plugins & CLI

## 1. Single-Flight Cache, Priority Queue + DLQ & Traversal-Safe Storage

`@forge-fr/cache`, `@forge-fr/queue`, and `@forge-fr/storage` share uniform adapters and DI plugins across Node.js and Bun:

```ts forge-example
import assert from 'node:assert/strict';
import { createMemoryCacheAdapter } from '@forge-fr/cache';
import { createMemoryQueueAdapter, createQueueWorker } from '@forge-fr/queue';
import { StoragePathError, createMemoryStorageAdapter } from '@forge-fr/storage';

// 1. O(1) LRU Cache + Single-Flight getOrSet
const cache = createMemoryCacheAdapter({ maxEntries: 100 });
let computations = 0;
const [first, second] = await Promise.all([
  cache.getOrSet('user:1', async () => {
    computations += 1;
    return { id: '1', name: 'Ada' };
  }),
  cache.getOrSet('user:1', async () => {
    computations += 1;
    return { id: '1', name: 'Ada' };
  }),
]);
assert.equal(computations, 1);
assert.deepEqual(first, second);

// 2. Bounded Priority Queue & Worker
const queue = createMemoryQueueAdapter({ maxQueueSize: 100 });
const processed: string[] = [];
const worker = createQueueWorker<{ to: string }>(
  queue,
  async (job) => {
    processed.push(job.payload.to);
  },
  { pollIntervalMs: 10 },
);
worker.start();
await queue.enqueue('email.send', { to: 'ops@forge.local' }, { idempotencyKey: 'welcome-1' });
const deadline = Date.now() + 1000;
while (processed.length === 0 && Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 10));
}
await worker.stop({ timeoutMs: 1000 });
assert.deepEqual(processed, ['ops@forge.local']);

// 3. Traversal-Safe Object Storage
const storage = createMemoryStorageAdapter();
await assert.rejects(
  () => storage.put('../etc/passwd', 'blocked', { contentType: 'text/plain' }),
  StoragePathError,
);
const stored = await storage.put('avatars/u1.png', new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), {
  contentType: 'image/png',
});
assert.equal(stored.key, 'avatars/u1.png');
```

## 2. Official Cross-Runtime CLI (`@forge-fr/cli`)

Programmatic verification of the `forge` CLI scaffolding, code generators, and diagnostics API:

```ts forge-example
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runCli } from '@forge-fr/cli';

const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-docs-cli-'));
try {
  const result = await runCli(
    ['new', 'orders-service', '--template', 'api', '--runtime', 'node', '--dir', tempRoot],
  );
  assert.equal(result.exitCode, 0);
  const pkg = JSON.parse(
    await fs.readFile(path.join(tempRoot, 'orders-service/package.json'), 'utf8'),
  ) as { type: string };
  assert.equal(pkg.type, 'module');
} finally {
  await fs.rm(tempRoot, { recursive: true, force: true });
}
```

## 3. WinterCG Edge Runtimes (`@forge-fr/edge`)

Deploy the exact same `ForgeHttpApp` to Cloudflare Workers, Deno Deploy, or standard WinterCG Fetch isolates without TCP socket listeners:

```ts forge-example
import assert from 'node:assert/strict';
import {
  createCloudflareWorkerHandler,
  createDenoHandler,
  getEdgeEnv,
} from '@forge-fr/edge';
import { createHttpApp } from '@forge-fr/http';

const app = createHttpApp();
app.get('/edge-info', (ctx) => {
  const env = getEdgeEnv<{ readonly REGION: string }>(ctx.request);
  return ctx.json({
    runtime: ctx.runtime,
    ip: ctx.remoteAddress,
    region: env?.REGION ?? 'local',
  });
});

const worker = createCloudflareWorkerHandler<{ readonly REGION: string }>(app, {
  trustCfConnectingIp: true,
});
const cfRes = await worker.fetch(
  new Request('https://api.example.com/edge-info', {
    headers: { 'cf-connecting-ip': '203.0.113.5' },
  }),
  { REGION: 'ap-southeast-1' },
);
assert.deepEqual(await cfRes.json(), {
  runtime: 'cloudflare-workers',
  ip: '203.0.113.5',
  region: 'ap-southeast-1',
});

const denoFetch = createDenoHandler(app);
const denoRes = await denoFetch(new Request('https://deno.example.com/edge-info'), {
  remoteAddr: { hostname: '198.51.100.9', port: 443 },
});
assert.deepEqual(await denoRes.json(), {
  runtime: 'deno',
  ip: '198.51.100.9',
  region: 'local',
});

await app.dispose();
```

