import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  PluginCapabilityError,
  PluginConfigError,
  createToken,
  definePlugin,
} from '@forge-fr/core';
import { createPluginTestHarness } from '../src/plugin-harness.js';

describe('@forge-fr/testing Plugin Test Harness (M3.2)', () => {
  it('boots an isolated plugin with dependencies, validates config, resolves exports, and checks health', async () => {
    const MetricsToken = createToken<{ count: () => number }>('Metrics');
    const CacheToken = createToken<{ get: (k: string) => string | undefined }>('Cache');

    const metricsPlugin = definePlugin({
      name: 'metrics',
      version: '1.0.0',
      forgeVersion: '^0.1.0 || ^1.0.0-rc.1',
      capabilities: ['di:register'],
      register: (ctx) => {
        ctx.registerProvider(
          { token: MetricsToken, useValue: { count: () => 42 } },
          { export: true },
        );
      },
    });

    const cachePlugin = definePlugin({
      name: 'cache',
      version: '1.0.0',
      forgeVersion: '^0.1.0 || ^1.0.0-rc.1',
      dependencies: { metrics: '^1.0.0' },
      capabilities: ['di:register', 'di:resolve', 'health:register'],
      configSchema: z.object({
        namespace: z.string().min(1),
        ttlSeconds: z.number().int().positive().default(60),
      }),
      register: (ctx, cfg) => {
        const metrics = ctx.resolve(MetricsToken);
        ctx.registerProvider(
          {
            token: CacheToken,
            useValue: {
              get: (k: string) => `${cfg.namespace}:${k}:${cfg.ttlSeconds}:${metrics.count()}`,
            },
          },
          { export: true },
        );
        ctx.registerHealthCheck('cache', () => ({ status: 'ok', message: cfg.namespace }));
      },
    });

    const harness = createPluginTestHarness({
      plugin: cachePlugin,
      config: { namespace: 'sessions' },
      dependencies: [metricsPlugin],
    });

    await harness.start();
    const cache = harness.resolveExport(CacheToken);
    expect(cache.get('u1')).toBe('sessions:u1:60:42');

    const health = await harness.health();
    expect(health.status).toBe('ok');
    expect(health.checks.cache?.message).toBe('sessions');

    expect(harness.getResolvedPlugins().map((p) => p.plugin.name)).toEqual(['metrics', 'cache']);
    await harness.dispose();
  });

  it('surfaces PluginConfigError and PluginCapabilityError cleanly during harness boot', async () => {
    const badCfgHarness = createPluginTestHarness({
      plugin: definePlugin({
        name: 'strict-cfg',
        version: '1.0.0',
        forgeVersion: '^0.1.0 || ^1.0.0-rc.1',
        configSchema: z.object({ apiKey: z.string().min(5) }),
      }),
      config: { apiKey: 'no' },
    });
    await expect(badCfgHarness.start()).rejects.toThrow(PluginConfigError);
    await badCfgHarness.dispose();

    const deniedHarness = createPluginTestHarness({
      plugin: definePlugin({
        name: 'denied-cap',
        version: '1.0.0',
        forgeVersion: '^0.1.0 || ^1.0.0-rc.1',
        capabilities: [],
        register: (ctx) => {
          ctx.registerHealthCheck('oops', () => ({ status: 'ok' }));
        },
      }),
    });
    await expect(deniedHarness.start()).rejects.toThrow(PluginCapabilityError);
    await deniedHarness.dispose();
  });
});
