# Architecture, DI Container, Modules & Capability-Scoped Plugins

ForgeJS keeps your core app logic (`@forge-fr/core`) and HTTP handling (`@forge-fr/http`) strictly separate from server runtimes (`@forge-fr/node`, `@forge-fr/bun`, `@forge-fr/edge`).

## 1. Dependency Injection & Request Scoping

`@forge-fr/core` supports `singleton`, `transient`, and `request` service lifetimes. It catches circular or mismatched dependencies early and runs async `dispose` cleanup callbacks in reverse order when shutting down:

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

## 2. Permission-Checked Plugins & Health Checks

Plugins list the exact permissions they need (`di:register`, `health:register`, `events:emit`, and more), validate their own settings with a `configSchema`, and can be tested in isolation with `createPluginTestHarness`:

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
