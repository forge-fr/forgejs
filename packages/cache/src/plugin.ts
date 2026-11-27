import {
  createToken,
  definePlugin,
  type ForgePlugin,
  type HealthCheckResult,
} from '@forge-fr/core';
import type { CacheAdapter } from './types.js';

export const CacheTokens = Object.freeze({
  Adapter: createToken<CacheAdapter>('@forge-fr/cache:Adapter'),
});

export interface CachePluginOptions {
  readonly adapter: CacheAdapter;
  /** Health check identifier registered in kernel health registry. Default: `'cache'`. */
  readonly healthCheckName?: string;
  /** Whether to register a kernel health check. Default: `true`. */
  readonly registerHealthCheck?: boolean;
}

export function createCachePlugin(
  options: CachePluginOptions,
): ForgePlugin<undefined, undefined> {
  const { adapter } = options;
  const healthCheckName = options.healthCheckName ?? 'cache';

  return definePlugin({
    name: '@forge-fr/cache',
    version: '1.0.0-rc.1',
    forgeVersion: '^0.1.0 || ^1.0.0-rc.1',
    capabilities: ['di:register', 'health:register'],
    register(ctx) {
      ctx.registerProvider(
        { token: CacheTokens.Adapter, useValue: adapter },
        { export: true },
      );

      if (options.registerHealthCheck !== false) {
        ctx.registerHealthCheck(healthCheckName, async (): Promise<HealthCheckResult> => {
          const healthy = await adapter.ping();
          return healthy
            ? { status: 'ok', details: { driver: adapter.driver } }
            : {
                status: 'unhealthy',
                message: `Cache adapter "${adapter.driver}" failed ping probe`,
                details: { driver: adapter.driver },
              };
        });
      }
    },
    async initialize() {
      await adapter.connect();
    },
    async onShutdown() {
      await adapter.disconnect();
    },
  });
}
