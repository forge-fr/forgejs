import {
  createToken,
  definePlugin,
  type ForgePlugin,
  type HealthCheckResult,
} from '@forge-fr/core';
import type { DurableEventBridge } from './durable-events.js';
import type { TransactionalOutbox } from './outbox.js';
import type { JobScheduler } from './scheduler.js';
import type { QueueAdapter, QueueWorker } from './types.js';

export const QueueTokens = Object.freeze({
  Queue: createToken<QueueAdapter>('@forge-fr/queue:Queue'),
  Worker: createToken<QueueWorker>('@forge-fr/queue:Worker'),
  Scheduler: createToken<JobScheduler>('@forge-fr/queue:Scheduler'),
  Outbox: createToken<TransactionalOutbox>('@forge-fr/queue:Outbox'),
  DurableEventBridge: createToken<DurableEventBridge>('@forge-fr/queue:DurableEventBridge'),
});

export interface QueuePluginOptions {
  readonly queue: QueueAdapter;
  readonly worker?: QueueWorker;
  readonly scheduler?: JobScheduler;
  readonly outbox?: TransactionalOutbox;
  readonly durableEvents?: DurableEventBridge;
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
  const { queue, worker, scheduler, outbox, durableEvents } = options;
  const drainTimeoutMs = options.drainTimeoutMs ?? 5000;
  const healthCheckName = options.healthCheckName ?? 'queue';

  return definePlugin({
    name: '@forge-fr/queue',
    version: '1.0.0',
    forgeVersion: '^0.1.0 || ^1.0.0-rc.1 || ^1.0.0',
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

      if (scheduler !== undefined) {
        ctx.registerProvider(
          { token: QueueTokens.Scheduler, useValue: scheduler },
          { export: true },
        );
      }

      if (outbox !== undefined) {
        ctx.registerProvider(
          { token: QueueTokens.Outbox, useValue: outbox },
          { export: true },
        );
      }

      if (durableEvents !== undefined) {
        ctx.registerProvider(
          { token: QueueTokens.DurableEventBridge, useValue: durableEvents },
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
      if (outbox !== undefined) {
        await outbox.ensureSchema();
      }
    },
    async onReady() {
      worker?.start();
      scheduler?.start();
      outbox?.startRelay();
    },
    async onShutdown() {
      durableEvents?.dispose();
      if (scheduler !== undefined) {
        await scheduler.stop();
      }
      if (outbox !== undefined) {
        await outbox.stopRelay();
      }
      if (worker !== undefined) {
        await worker.stop({ timeoutMs: drainTimeoutMs });
      }
      await queue.disconnect();
    },
  });
}
