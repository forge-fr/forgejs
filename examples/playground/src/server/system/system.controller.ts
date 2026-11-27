import { UnauthorizedError } from '@forge-fr/core';
import { extractBearerToken, requireAuth } from '@forge-fr/auth';
import {
  createSseResponse,
  type ForgeContext,
  type ForgeHttpApp,
} from '@forge-fr/http';
import { validatedOpenApiHandler } from '@forge-fr/openapi';
import { z } from 'zod';
import { requireBearerAuth } from '../auth/auth.middleware.ts';
import { SystemServiceToken } from './system.service.ts';

const RedactTestBodySchema = z.object({
  email: z.string().min(1).max(120).default('elena@acme.dev'),
  password: z.string().min(1).max(120).default('SuperSecretPass!2026'),
  authorization: z.string().min(1).max(180).default('Bearer eyJhbGciOiJIUzI1NiJ9.live_demo_secret'),
  apiKey: z.string().min(1).max(120).default('fjs_key_demo_991188227733'),
  clientSecret: z.string().min(1).max(120).default('oauth_client_secret_xyz987'),
  note: z.string().min(1).max(200).default('Audit event with database postgres://admin:dbPass99@db.internal:5432/app'),
});

const HealthFaultBodySchema = z.object({
  unhealthy: z.boolean().optional(),
});

export function registerSystemController(app: ForgeHttpApp): void {
  app.group('/playground-api', (group) => {
    group.get(
      '/meta',
      validatedOpenApiHandler(
        {},
        (ctx) => {
          const system = ctx.resolve(SystemServiceToken);
          ctx.setHeader('cache-control', 'no-store');
          return ctx.json(system.getMeta());
        },
        {
          summary: 'Retrieve public playground metadata and demo personas',
          tags: ['System'],
        },
      ),
    );

    group.get('/events', async (ctx: ForgeContext) => {
      const system = ctx.resolve(SystemServiceToken);
      const rawToken =
        extractBearerToken(ctx.request) ?? ctx.url.searchParams.get('access_token');
      if (!rawToken) {
        throw new UnauthorizedError('Authentication token required for SSE stream');
      }

      const { tenantId, actorName } = await system.verifyEventsToken(rawToken);

      return createSseResponse(
        async (stream) => {
          stream.send({
            event: 'connected',
            data: {
              id: `evt_conn_${Date.now().toString(36)}`,
              tenantId,
              type: 'connected',
              actorName,
              summary: `Subscribed to real-time ForgeJS SSE stream for tenant "${tenantId}"`,
              data: { recentCount: system.getRecentEventsCount(tenantId) },
              timestamp: new Date().toISOString(),
            },
          });

          const unsubscribe = system.subscribeEvents(tenantId, (event) => {
            stream.send({
              id: event.id,
              event: event.type,
              data: event,
            });
          });

          const heartbeat = setInterval(() => {
            if (!stream.closed) {
              stream.comment('heartbeat');
            }
          }, 15_000);

          await new Promise<void>((resolve) => {
            const done = (): void => {
              clearInterval(heartbeat);
              unsubscribe();
              resolve();
            };
            if (ctx.signal.aborted) {
              done();
              return;
            }
            ctx.signal.addEventListener('abort', done, { once: true });
          });
        },
        { signal: ctx.signal },
      );
    });

    group.get(
      '/logs',
      validatedOpenApiHandler(
        {},
        (ctx) => {
          requireAuth(ctx);
          const system = ctx.resolve(SystemServiceToken);
          return ctx.json({ logs: system.getLogs() });
        },
        {
          summary: 'Read recent PII-redacted structured logs captured by @forge-fr/logger',
          tags: ['System'],
        },
      ),
      { middleware: [requireBearerAuth] },
    );

    group.get(
      '/observability/summary',
      validatedOpenApiHandler(
        {},
        (ctx) => {
          const system = ctx.resolve(SystemServiceToken);
          return ctx.json(system.getObservabilitySummary(app.kernel, app));
        },
        {
          summary: 'Read live OpenTelemetry metrics, recent W3C spans, and Kernel DI module topology',
          tags: ['Observability'],
        },
      ),
    );

    group.post(
      '/observability/redact-test',
      validatedOpenApiHandler(
        { body: RedactTestBodySchema },
        (ctx, { body }) => {
          requireAuth(ctx);
          const system = ctx.resolve(SystemServiceToken);
          const redactedEntry = system.runPiiRedactionDemo(ctx.logger, body);
          return ctx.json({
            logged: true,
            redactedEntry,
          });
        },
        {
          summary: 'Submit sensitive fields to @forge-fr/logger and inspect automatic [REDACTED] output',
          tags: ['Observability'],
        },
      ),
      { middleware: [requireBearerAuth] },
    );

    group.post(
      '/observability/health-fault',
      validatedOpenApiHandler(
        { body: HealthFaultBodySchema },
        (ctx, { body }) => {
          requireAuth(ctx);
          const system = ctx.resolve(SystemServiceToken);
          const unhealthy = system.toggleHealthFault(body.unhealthy);
          return ctx.json({
            faultInjected: unhealthy,
            status: unhealthy ? 'unhealthy' : 'ok',
          });
        },
        {
          summary: 'Toggle simulated fault on demo_dependency check in kernel.health (/health/ready 200 vs 503)',
          tags: ['Observability'],
        },
      ),
      { middleware: [requireBearerAuth] },
    );

    group.post(
      '/sandbox/reset',
      validatedOpenApiHandler(
        {},
        async (ctx) => {
          const system = ctx.resolve(SystemServiceToken);
          await system.resetSandbox();
          return ctx.json({
            reset: true,
            message: 'Sandbox state, cache, queue, storage, and security windows have been restored.',
            timestamp: new Date().toISOString(),
          });
        },
        {
          summary: 'Reset the in-memory ForgeJS sandbox back to initial multi-tenant seed data',
          tags: ['System'],
        },
      ),
    );
  });
}
