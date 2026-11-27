# Architecture, DI Container, Modules & Capability-Scoped Plugins

ForgeJS enforces strict separation between runtime-agnostic core primitives (`@forge-fr/core`), HTTP/Web Standards handling (`@forge-fr/http`), and runtime edge adapters (`@forge-fr/node`, `@forge-fr/bun`, `@forge-fr/edge`).

## 1. Dependency Injection & Request Scoping

`@forge-fr/core` supports `singleton`, `transient`, and `request` provider lifetimes, prevents captive dependencies, detects dependency cycles, and runs async `dispose` hooks in reverse LIFO order:

```ts forge-example
import assert from 'node:assert/strict';
import { createContainer, createToken } from '@forge-fr/core';

const ConfigToken = createToken<{ appName: string }>('app.config');
const RequestIdToken = createToken<string>('request.id');

const disposed: string[] = [];
let seq = 0;

const container = createContainer();
container.register({
  token: ConfigToken,
  useValue: { appName: 'forge-orders' },
  dispose: () => {
    disposed.push('config');
  },
});
container.register({
  token: RequestIdToken,
  scope: 'request',
  useFactory: () => `req-${++seq}`,
  dispose: (id) => {
    disposed.push(id);
  },
});

const scope1 = container.createScope();
assert.equal(scope1.resolve(RequestIdToken), 'req-1');
assert.equal(scope1.resolve(RequestIdToken), 'req-1');
assert.equal(scope1.resolve(ConfigToken).appName, 'forge-orders');
await scope1.dispose();

const scope2 = container.createScope();
assert.equal(scope2.resolve(RequestIdToken), 'req-2');
await scope2.dispose();
await container.dispose();

assert.deepEqual(disposed, ['req-1', 'req-2', 'config']);
```

## 2. Capability-Scoped Plugins & Health Checks

Plugins declare explicit capabilities (`di:register`, `health:register`, `events:emit`, etc.), optional Standard Schema `configSchema` validation, and isolated `exportProvider()` visibility tested via `createPluginTestHarness`:

```ts forge-example
import assert from 'node:assert/strict';
import { createToken, definePlugin } from '@forge-fr/core';
import { createPluginTestHarness } from '@forge-fr/testing';
import { z } from 'zod';

const MetricsPortToken = createToken<number>('metrics.port');

const MetricsPlugin = definePlugin({
  name: 'metrics-plugin',
  version: '1.0.0',
  forgeVersion: '^1.0.0-rc.1',
  capabilities: ['di:register', 'health:register'],
  configSchema: z.object({
    port: z.number().int().min(1024).default(9090),
  }),
  register(ctx, config) {
    ctx.registerProvider(
      {
        token: MetricsPortToken,
        useValue: config.port,
      },
      { export: true },
    );
    ctx.registerHealthCheck('metrics', () => ({ status: 'ok' }));
  },
});

const harness = createPluginTestHarness({
  plugin: MetricsPlugin,
  config: { port: 9100 },
});

await harness.start();
assert.equal(harness.resolveExport(MetricsPortToken), 9100);
const health = await harness.health();
assert.equal(health.status, 'ok');
await harness.shutdown();
```
