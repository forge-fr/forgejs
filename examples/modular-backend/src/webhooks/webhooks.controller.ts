import { requireAuth } from '@forge-fr/auth';
import type { ForgeHttpApp } from '@forge-fr/http';
import { validatedOpenApiHandler } from '@forge-fr/openapi';
import { z } from 'zod';
import { requireBearerAuth } from '../auth/auth.middleware.ts';
import { WebhooksServiceToken } from './webhooks.service.ts';

const WebhookEventSchema = z.enum([
  'task.created',
  'task.updated',
  'task.completed',
  'task.deleted',
  'attachment.uploaded',
  'webhook.test',
]);

const IdParamSchema = z.object({
  id: z.string().min(1).max(80),
});

const JobIdParamSchema = z.object({
  jobId: z.string().min(1).max(80),
});

const CreateWebhookBodySchema = z.object({
  name: z.string().trim().min(2).max(100),
  targetUrl: z.string().trim().min(8).max(500),
  events: z.array(WebhookEventSchema).min(1).max(6),
});

const ReplayBodySchema = z
  .object({
    overrideHealthySink: z.boolean().optional(),
  })
  .optional();

export function registerWebhooksController(app: ForgeHttpApp): void {
  app.group(
    '/playground-api/webhooks',
    (group) => {
      group.get(
        '/',
        validatedOpenApiHandler(
          {},
          async (ctx) => {
            const identity = requireAuth(ctx);
            const webhooks = ctx.resolve(WebhooksServiceToken);
            const result = await webhooks.listForTenant(identity);
            return ctx.json(result);
          },
          {
            summary: 'List tenant webhooks, recent delivery logs, Dead-Letter Queue jobs, and queue stats',
            tags: ['Webhooks'],
          },
        ),
      );

      group.post(
        '/',
        validatedOpenApiHandler(
          { body: CreateWebhookBodySchema },
          async (ctx, { body }) => {
            const identity = requireAuth(ctx);
            const webhooks = ctx.resolve(WebhooksServiceToken);
            const endpoint = await webhooks.register(identity, body);
            return ctx.json({ webhook: endpoint }, { status: 201 });
          },
          {
            summary: 'Register a tenant webhook (Admin-only, protected by @forge-fr/security SSRF guard)',
            tags: ['Webhooks'],
          },
        ),
      );

      group.delete(
        '/:id',
        validatedOpenApiHandler(
          { params: IdParamSchema },
          (ctx, { params }) => {
            const identity = requireAuth(ctx);
            const webhooks = ctx.resolve(WebhooksServiceToken);
            webhooks.remove(identity, params.id);
            return ctx.json({ deleted: true, webhookId: params.id });
          },
          {
            summary: 'Delete a tenant webhook endpoint (Admin-only)',
            tags: ['Webhooks'],
          },
        ),
      );

      group.post(
        '/:id/test',
        validatedOpenApiHandler(
          { params: IdParamSchema },
          async (ctx, { params }) => {
            const identity = requireAuth(ctx);
            const webhooks = ctx.resolve(WebhooksServiceToken);
            const result = await webhooks.triggerTest(identity, params.id);
            return ctx.json(
              {
                enqueued: true,
                webhookId: result.webhook.id,
                targetUrl: result.webhook.targetUrl,
                queueStats: result.queueStats,
              },
              { status: 202 },
            );
          },
          {
            summary: 'Enqueue a test webhook delivery job onto @forge-fr/queue',
            tags: ['Webhooks'],
          },
        ),
      );

      group.post(
        '/dlq/:jobId/replay',
        validatedOpenApiHandler(
          { params: JobIdParamSchema, body: ReplayBodySchema },
          async (ctx, { params, body }) => {
            const identity = requireAuth(ctx);
            const webhooks = ctx.resolve(WebhooksServiceToken);
            const job = await webhooks.replayDeadLetter(
              identity,
              params.jobId,
              body?.overrideHealthySink,
            );
            return ctx.json({
              replayed: true,
              job,
            });
          },
          {
            summary: 'Replay a failed webhook job from the @forge-fr/queue Dead-Letter Queue (Admin-only)',
            tags: ['Webhooks'],
          },
        ),
      );
    },
    { middleware: [requireBearerAuth] },
  );
}
