import {
  createToken,
  definePlugin,
  type ForgePlugin,
  type HealthCheckResult,
} from '@forge-fr/core';
import type { StorageAdapter } from './types.js';

export const StorageTokens = Object.freeze({
  Adapter: createToken<StorageAdapter>('@forge-fr/storage:Adapter'),
});

export interface StoragePluginOptions {
  readonly adapter: StorageAdapter;
  /** Health check identifier registered in kernel health registry. Default: `'storage'`. */
  readonly healthCheckName?: string;
  /** Whether to register a kernel health check. Default: `true`. */
  readonly registerHealthCheck?: boolean;
}

export function createStoragePlugin(
  options: StoragePluginOptions,
): ForgePlugin<undefined, undefined> {
  const { adapter } = options;
  const healthCheckName = options.healthCheckName ?? 'storage';

  return definePlugin({
    name: '@forge-fr/storage',
    version: '1.0.0',
    forgeVersion: '^0.1.0 || ^1.0.0-rc.1 || ^1.0.0',
    capabilities: ['di:register', 'health:register'],
    register(ctx) {
      ctx.registerProvider(
        { token: StorageTokens.Adapter, useValue: adapter },
        { export: true },
      );

      if (options.registerHealthCheck !== false) {
        ctx.registerHealthCheck(healthCheckName, async (): Promise<HealthCheckResult> => {
          const healthy = await adapter.ping();
          return healthy
            ? { status: 'ok', details: { driver: adapter.driver } }
            : {
                status: 'unhealthy',
                message: `Storage adapter "${adapter.driver}" failed ping probe`,
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
