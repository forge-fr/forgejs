import type { ApplicationKernel } from '@forge-fr/core';
import type { PasswordHasher } from '@forge-fr/auth';
import {
  createHttpApp,
  type ForgeHttpApp,
  type HttpRuntimeAdapter,
} from '@forge-fr/http';
import {
  createCachePlugin,
  createMemoryCacheAdapter,
  type CacheAdapter,
} from '@forge-fr/cache';
import {
  createCorrelationIdMiddleware,
  createMemoryLogSink,
  createOtelHttpMiddleware,
  createPinoLogger,
  createRequestLoggingMiddleware,
  registerHealthRoutes,
  type MemoryLogSink,
} from '@forge-fr/logger';
import { registerOpenApiRoutes } from '@forge-fr/openapi';
import {
  createMemoryQueueAdapter,
  createQueuePlugin,
  createQueueWorker,
  type QueueAdapter,
  type QueueWorker,
} from '@forge-fr/queue';
import {
  createRateLimitMiddleware,
  createSecurityHeadersMiddleware,
} from '@forge-fr/security';
import {
  createMemoryStorageAdapter,
  createStoragePlugin,
  type StorageAdapter,
} from '@forge-fr/storage';
import { registerAuthController } from './auth/auth.controller.ts';
import { authModule } from './auth/auth.module.ts';
import { AuthServiceToken } from './auth/auth.service.ts';
import { registerAttachmentsController } from './attachments/attachments.controller.ts';
import { attachmentsModule } from './attachments/attachments.module.ts';
import { registerRealtimeController } from './realtime/realtime.controller.ts';
import { realtimeModule } from './realtime/realtime.module.ts';
import { RealtimeServiceToken } from './realtime/realtime.service.ts';
import { registerSecurityController } from './security/security.controller.ts';
import { securityModule } from './security/security.module.ts';
import { SecurityServiceToken } from './security/security.service.ts';
import { PlaygroundStore, PlaygroundStoreToken } from './store.ts';
import {
  ObservabilityServiceToken,
  createObservabilityService,
} from './system/observability.ts';
import { registerSystemController } from './system/system.controller.ts';
import { systemModule } from './system/system.module.ts';
import { registerTasksController } from './tasks/tasks.controller.ts';
import { tasksModule } from './tasks/tasks.module.ts';
import {
  PlaygroundTokens,
  type WebhookJobPayload,
} from './types.ts';
import { registerWebhooksController } from './webhooks/webhooks.controller.ts';
import { webhooksModule } from './webhooks/webhooks.module.ts';

export interface PlaygroundBackend {
  readonly kernel: ApplicationKernel;
  readonly app: ForgeHttpApp;
  readonly store: PlaygroundStore;
  readonly cache: CacheAdapter;
  readonly queue: QueueAdapter;
  readonly worker: QueueWorker;
  readonly storage: StorageAdapter;
  readonly logSink: MemoryLogSink;
  start(): Promise<void>;
  reset(): Promise<void>;
  close(): Promise<void>;
}

export interface PlaygroundBackendOptions {
  readonly adapter?: HttpRuntimeAdapter;
  readonly passwordHasher?: PasswordHasher;
  readonly jwtSecret?: string;
  readonly edgeMode?: boolean;
}

export function createPlaygroundBackend(
  options: PlaygroundBackendOptions = {},
): PlaygroundBackend {
  const isEdgeRuntime = options.edgeMode ?? options.adapter?.name === 'edge';
  const observability = createObservabilityService('forgejs-live-playground');
  const logSink = createMemoryLogSink();
  const logger = createPinoLogger({
    name: 'forgejs-live-playground',
    level: 'info',
    traceContextProvider: () => observability.instrumentation.getActiveTraceContext(),
    destination: logSink.stream,
  });

  const store = new PlaygroundStore();
  const replayHealthyOverrides = new Set<string>();

  const cache = createMemoryCacheAdapter({
    maxEntries: 500,
    defaultTtlMs: 30_000,
  });

  const queue = createMemoryQueueAdapter({
    maxQueueSize: 500,
    defaultMaxAttempts: 2,
    defaultBackoff: { type: 'fixed', delayMs: isEdgeRuntime ? 0 : 60 },
  });

  const storage = createMemoryStorageAdapter({
    allowedMimeTypes: ['image/png', 'text/plain', 'application/json', 'application/pdf'],
    verifyMagicBytes: true,
    maxObjectBytes: 512 * 1024,
  });

  async function executeWebhookJob(
    job: { readonly id: string; readonly name: string; readonly payload: unknown },
    attempt: number,
  ): Promise<unknown> {
    if (job.name !== 'webhook.deliver') {
      return { ignored: true };
    }
    const payload = job.payload as WebhookJobPayload;
    const effectiveTarget = replayHealthyOverrides.has(job.id)
      ? 'sandbox://sink/ok'
      : payload.targetUrl;

    // Deterministic sandbox sink simulation (no unsafe external outbound network traffic)
    if (effectiveTarget === 'sandbox://sink/fail') {
      throw new Error('502 Bad Gateway from sandbox://sink/fail (simulated receiver outage)');
    }

    if (effectiveTarget === 'sandbox://sink/flaky' && attempt === 1) {
      throw new Error('503 Service Unavailable on attempt 1 from sandbox://sink/flaky');
    }

    return {
      delivered: true,
      statusCode: 200,
      targetUrl: effectiveTarget,
      attempt,
    };
  }

  function handleJobCompleted(job: {
    readonly id: string;
    readonly attempts: number;
    readonly payload: unknown;
  }): void {
    replayHealthyOverrides.delete(job.id);
    const payload = job.payload as WebhookJobPayload;
    store.updateDeliveryByJobId(job.id, {
      status: 'delivered',
      attempts: job.attempts,
      statusCode: 200,
      lastError: undefined,
    });
    store.publishEvent({
      tenantId: payload.tenantId,
      type: 'webhook.delivered',
      actorName: '@forge-fr/queue',
      summary: `Delivered ${payload.eventType} to "${payload.webhookName}" (200 OK)`,
      data: {
        jobId: job.id,
        webhookId: payload.webhookId,
        attempts: job.attempts,
      },
    });
  }

  function handleJobFailed(
    job: {
      readonly id: string;
      readonly attempts: number;
      readonly maxAttempts: number;
      readonly payload: unknown;
    },
    err: unknown,
  ): void {
    const payload = job.payload as WebhookJobPayload;
    const message = err instanceof Error ? err.message : String(err);
    store.updateDeliveryByJobId(job.id, {
      status: 'retrying',
      attempts: job.attempts,
      statusCode: 502,
      lastError: message,
    });
    store.publishEvent({
      tenantId: payload.tenantId,
      type: 'webhook.retrying',
      actorName: '@forge-fr/queue',
      summary: `Attempt ${job.attempts}/${job.maxAttempts} failed for "${payload.webhookName}" — retrying`,
      data: { jobId: job.id, error: message },
    });
  }

  function handleJobDeadLetter(
    job: {
      readonly id: string;
      readonly attempts: number;
      readonly payload: unknown;
    },
    err: unknown,
  ): void {
    const payload = job.payload as WebhookJobPayload;
    const message = err instanceof Error ? err.message : String(err);
    store.updateDeliveryByJobId(job.id, {
      status: 'dlq',
      attempts: job.attempts,
      statusCode: 502,
      lastError: message,
    });
    store.publishEvent({
      tenantId: payload.tenantId,
      type: 'webhook.dlq',
      actorName: '@forge-fr/queue',
      summary: `Job ${job.id} moved to Dead-Letter Queue after ${job.attempts} attempts`,
      data: { jobId: job.id, webhookId: payload.webhookId, error: message },
    });
  }

  const worker = createQueueWorker(
    queue,
    async (job, execCtx) => executeWebhookJob(job, execCtx.attempt),
    {
      pollIntervalMs: 20,
      concurrency: 4,
      onCompleted: handleJobCompleted,
      onFailed: handleJobFailed,
      onDeadLetter: handleJobDeadLetter,
    },
  );

  async function drainQueueInline(): Promise<void> {
    if (!isEdgeRuntime) return;
    // Bounded synchronous-style drain for serverless Edge isolates (no background setTimeout loops)
    for (let step = 0; step < 32; step += 1) {
      const job = await queue.dequeue();
      if (!job) break;
      try {
        const result = await executeWebhookJob(job, job.attempts);
        const completed = await queue.complete(job.id, result);
        handleJobCompleted(completed);
      } catch (err: unknown) {
        const outcome = await queue.fail(job.id, err);
        handleJobFailed(outcome.job, err);
        if (outcome.status === 'dead') {
          handleJobDeadLetter(outcome.job, err);
        }
      }
    }
  }

  let kernelRef: ApplicationKernel | null = null;

  async function reset(): Promise<void> {
    if (!kernelRef) return;
    const authService = kernelRef.container.resolve(AuthServiceToken);
    const securityService = kernelRef.container.resolve(SecurityServiceToken);
    const realtimeService = kernelRef.container.resolve(RealtimeServiceToken);
    authService.resetEphemeralAuthState();
    securityService.resetSecurityState();
    realtimeService.resetRealtimeState();
    observability.resetObservability();
    replayHealthyOverrides.clear();
    await cache.clear();
    await queue.purge();
    await store.seed(authService.passwordHasher, storage);
    store.publishEvent({
      tenantId: '*',
      type: 'sandbox.reset',
      actorName: 'Sandbox Controller',
      summary: 'Sandbox restored to initial multi-tenant seed data',
      data: {},
    });
  }

  const app = createHttpApp({
    ...(options.adapter !== undefined ? { adapter: options.adapter } : {}),
    logger,
    providers: [
      { token: PlaygroundStoreToken, useValue: store },
      { token: PlaygroundTokens.LogSink, useValue: logSink },
      { token: PlaygroundTokens.ReplayHealthyOverrides, useValue: replayHealthyOverrides },
      { token: PlaygroundTokens.ResetSandbox, useValue: reset },
      { token: PlaygroundTokens.DrainQueue, useValue: drainQueueInline },
      {
        token: PlaygroundTokens.AuthConfig,
        useValue: {
          passwordHasher: options.passwordHasher,
          jwtSecret: options.jwtSecret,
        },
      },
      { token: ObservabilityServiceToken, useValue: observability },
    ],
    modules: [
      authModule,
      securityModule,
      realtimeModule,
      webhooksModule,
      tasksModule,
      attachmentsModule,
      systemModule,
    ],
    plugins: [
      createCachePlugin({ adapter: cache }),
      createQueuePlugin({
        queue,
        ...(isEdgeRuntime ? {} : { worker }),
        drainTimeoutMs: 2_000,
      }),
      createStoragePlugin({ adapter: storage }),
    ],
    trustRequestId: true,
    production: false,
  });
  const kernel = app.kernel;
  kernelRef = kernel;

  // Register controlled fault-injectable dependency health check
  kernel.health.register('demo_dependency', () =>
    observability.isFaultInjected()
      ? {
          status: 'unhealthy',
          message: 'Simulated dependency degradation triggered from Playground Observability lab',
        }
      : {
          status: 'ok',
          details: { mode: 'nominal' },
        },
  );

  // Global ForgeJS middleware pipeline
  app.use(createCorrelationIdMiddleware());
  app.use(
    createOtelHttpMiddleware({
      instrumentation: observability.instrumentation,
      exposeTraceIdHeader: true,
      ignorePaths: ['/playground-api/health/live'],
    }),
  );
  app.use(createRequestLoggingMiddleware({ logger }));
  app.use(
    createSecurityHeadersMiddleware({
      contentTypeOptions: 'nosniff',
      frameOptions: 'SAMEORIGIN',
      referrerPolicy: 'no-referrer',
      crossOriginOpenerPolicy: false,
      crossOriginResourcePolicy: 'same-origin',
      contentSecurityPolicy: false,
      hsts: false,
    }),
  );
  app.use(
    createRateLimitMiddleware({
      max: 300,
      windowMs: 60_000,
    }),
  );

  app.addHook('onResponse', ({ ctx, statusCode, durationMs }) => {
    observability.recordHttpResponse(ctx.method, ctx.path, statusCode, durationMs);
  });

  // Register opinionated ForgeJS domain controllers
  registerAuthController(app);
  registerSecurityController(app);
  registerRealtimeController(app);
  registerTasksController(app);
  registerAttachmentsController(app);
  registerWebhooksController(app);
  registerSystemController(app);

  // Register production-grade liveness & readiness health probes (@forge-fr/logger)
  registerHealthRoutes(app, {
    registry: kernel.health,
    livePath: '/playground-api/health/live',
    readyPath: '/playground-api/health/ready',
    exposeDetails: true,
  });

  // Register live auto-introspected OpenAPI 3.1 spec + Swagger UI (@forge-fr/openapi)
  registerOpenApiRoutes(app, {
    title: 'ForgeJS Live Playground — Multi-Tenant Task & Webhook API',
    version: '1.0.0-rc.1',
    description:
      'Complete reference ForgeJS backend showcasing @forge-fr/core, @forge-fr/http, @forge-fr/validation, @forge-fr/auth, @forge-fr/authorization, @forge-fr/security, @forge-fr/cache, @forge-fr/queue, @forge-fr/storage, @forge-fr/logger, and @forge-fr/openapi.',
    specPath: '/playground-api/openapi.json',
    docsPath: '/playground-api/docs',
  });

  let started = false;

  return {
    kernel,
    app,
    store,
    cache,
    queue,
    worker,
    storage,
    logSink,
    async start(): Promise<void> {
      if (started) return;
      await kernel.start();
      const authService = kernel.container.resolve(AuthServiceToken);
      await store.seed(authService.passwordHasher, storage);
      started = true;
    },
    reset,
    async close(): Promise<void> {
      if (!started) return;
      started = false;
      await app.close();
    },
  };
}
