# Creating Plugins

> Author, validate, and test custom ForgeJS plugins with definePlugin(), Standard Schema config validation, and createPluginTestHarness().

- **Section**: Plugins & Extensions
- **Packages**: @forge-fr/core, @forge-fr/testing
- **Version**: v1.0.0-rc.1
- **Updated**: 2026-11-26
- **HTML URL**: https://github.com/forge-fr/forgejs/docs/plugins/creating-plugins
- **Markdown URL**: https://github.com/forge-fr/forgejs/docs/plugins/creating-plugins.md
- **Source**: https://github.com/forge-fr/forgejs/blob/main/docs/architecture.md

## Authoring with definePlugin()

Use definePlugin() with explicit capabilities, a forgeVersion SemVer range, and a Standard Schema v1 configSchema so invalid plugin configurations fail fast during the configure stage.

**File: `src/plugins/metrics.plugin.ts`**

```ts
import { createToken, definePlugin, FORGE_CORE_VERSION } from '@forge-fr/core';
import { z } from 'zod';

export interface MetricsClient {
  increment(metric: string): void;
}

export const MetricsToken = createToken<MetricsClient>('acme:metrics');

export const metricsPlugin = definePlugin({
  name: 'acme-metrics',
  version: '1.0.0',
  forgeVersion: `^${FORGE_CORE_VERSION}`,
  capabilities: ['di:register', 'health:register'],
  configSchema: z.object({
    namespace: z.string().min(1).default('app'),
  }),
  register(ctx, config) {
    ctx.registerProvider({
      token: MetricsToken,
      scope: 'singleton',
      useValue: {
        increment: (metric) => console.info(`[${config.namespace}] ${metric}`),
      },
    });
    ctx.registerHealthCheck('acme-metrics', () => ({ status: 'up' }));
  },
});
```

## Isolated plugin testing with createPluginTestHarness()

createPluginTestHarness({ plugin, config }) boots a real ApplicationKernel with your plugin, validates exported tokens via resolveExport(), checks health probes, and exercises teardown.

**File: `tests/metrics.plugin.test.ts`**

```ts
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
  configSchema: z.object({ port: z.number().int().min(1024).default(9090) }),
  register(ctx, config) {
    ctx.registerProvider({ token: MetricsPortToken, useValue: config.port }, { export: true });
    ctx.registerHealthCheck('metrics', () => ({ status: 'ok' }));
  },
});

const harness = createPluginTestHarness({
  plugin: MetricsPlugin,
  config: { port: 9100 },
});

await harness.start();
assert.equal(harness.resolveExport(MetricsPortToken), 9100);
assert.equal((await harness.health()).status, 'ok');
await harness.shutdown();
```
