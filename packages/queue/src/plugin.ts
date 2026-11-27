import {
  createToken,
  definePlugin,
  type ForgePlugin,
  type HealthCheckResult,
} from '@forge-fr/core';
import type { QueueAdapter, QueueWorker } from './types.js';

export const QueueTokens = Object.freeze({
  Queue: createToken<QueueAdapter>('@forge-fr/queue:Queue'),
  Worker: createToken<QueueWorker>('@forge-fr/queue:Worker'),
});

export interface QueuePluginOptions {
  readonly queue: QueueAdapter;
  readonly worker?: QueueWorker;
  /** Graceful shutdown drain window in milliseconds. Default: `5000`. */
  readonly drainTimeoutMs?: number;
  /** Health check identifier registered in kernel health registry. Default: `'queue'`. */
  readonly healthCheckName?: string;
  /** Whether to register a kernel health check. Default: `true`. */
  readonly registerHealthCheck?: boolean;
}

export function createQueuePlugin(
  options: QueuePluginOptions,
): ForgePlugin<undefined, undefined> {
  const { queue, worker } = options;
  const drainTimeoutMs = options.drainTimeoutMs ?? 5000;
  const healthCheckName = options.healthCheckName ?? 'queue';

  return definePlugin({
    name: '@forge-fr/queue',
    version: '1.0.0-rc.2',
    forgeVersion: '^0.1.0 || ^1.0.0-rc.1',
    capabilities: ['di:register', 'health:register'],
    register(ctx) {
      ctx.registerProvider(
        { token: QueueTokens.Queue, useValue: queue },
        { export: true },
      );

      if (worker !== undefined) {
        ctx.registerProvider(
          { token: QueueTokens.Worker, useValue: worker },
          { export: true },
        );
      }

      if (options.registerHealthCheck !== false) {
        ctx.registerHealthCheck(healthCheckName, async (): Promise<HealthCheckResult> => {
          const healthy = await queue.ping();
          const stats = queue.stats();
          return healthy
            ? {
                status: 'ok',
                details: {
                  driver: queue.driver,
                  waiting: stats.waiting,
                  active: stats.active,
                  dead: stats.dead,
                },
              }
            : {
                status: 'unhealthy',
                message: `Queue adapter "${queue.driver}" failed ping probe`,
                details: { driver: queue.driver },
              };
        });
      }
    },
    async initialize() {
      await queue.connect();
    },
    async onReady() {
      worker?.start();
    },
    async onShutdown() {
      if (worker !== undefined) {
        await worker.stop({ timeoutMs: drainTimeoutMs });
      }
      await queue.disconnect();
    },
  });
}
