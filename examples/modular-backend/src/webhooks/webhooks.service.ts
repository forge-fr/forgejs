import {
  createToken,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from '@forge-fr/core';
import type { AuthIdentity } from '@forge-fr/auth';
import { assertTenantIsolation } from '@forge-fr/authorization';
import type { QueueAdapter, QueueStats } from '@forge-fr/queue';
import { validateOutboundUrl } from '@forge-fr/security';
import { toActor, type AuthService } from '../auth/auth.service.ts';
import type { PlaygroundStore } from '../store.ts';
import {
  ALLOWED_SANDBOX_SINKS,
  type WebhookDeliveryRecord,
  type WebhookEndpointRecord,
  type WebhookEventType,
  type WebhookJobPayload,
} from '../types.ts';

export interface DeadLetterSummary {
  readonly id: string;
  readonly name: string;
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly lastError: string;
  readonly payload: unknown;
  readonly createdAt: string;
}

export interface ListWebhooksResult {
  readonly endpoints: readonly WebhookEndpointRecord[];
  readonly deliveries: readonly WebhookDeliveryRecord[];
  readonly deadLetters: readonly DeadLetterSummary[];
  readonly queueStats: QueueStats;
}

export interface RegisterWebhookInput {
  readonly name: string;
  readonly targetUrl: string;
  readonly events: readonly WebhookEventType[];
}

export interface WebhooksService {
  listForTenant(identity: AuthIdentity): Promise<ListWebhooksResult>;
  register(identity: AuthIdentity, input: RegisterWebhookInput): Promise<WebhookEndpointRecord>;
  remove(identity: AuthIdentity, webhookId: string): void;
  triggerTest(
    identity: AuthIdentity,
    webhookId: string,
  ): Promise<{ readonly webhook: WebhookEndpointRecord; readonly queueStats: QueueStats }>;
  replayDeadLetter(
    identity: AuthIdentity,
    jobId: string,
    overrideHealthySink?: boolean,
  ): Promise<{ readonly id: string; readonly status: string; readonly attempts: number }>;
  enqueueMatching(
    tenantId: string,
    eventType: WebhookEventType,
    data: Readonly<Record<string, unknown>>,
    specificWebhook?: WebhookEndpointRecord,
  ): Promise<number>;
}

export const WebhooksServiceToken = createToken<WebhooksService>('playground:WebhooksService');

export interface WebhooksServiceDeps {
  readonly store: PlaygroundStore;
  readonly queue: QueueAdapter;
  readonly auth: AuthService;
  readonly replayHealthyOverrides: Set<string>;
}

async function validateWebhookTarget(targetUrl: string): Promise<string> {
  const trimmed = targetUrl.trim();
  if (ALLOWED_SANDBOX_SINKS.has(trimmed)) {
    return trimmed;
  }
  if (trimmed.startsWith('sandbox://')) {
    throw new ValidationError(
      'Sandbox sink URL must be one of: sandbox://sink/ok, sandbox://sink/fail, sandbox://sink/flaky',
    );
  }
  const validated = await validateOutboundUrl(trimmed);
  return validated.toString();
}

export function createWebhooksService(deps: WebhooksServiceDeps): WebhooksService {
  const { store, queue, auth, replayHealthyOverrides } = deps;

  async function enqueueMatching(
    tenantId: string,
    eventType: WebhookEventType,
    data: Readonly<Record<string, unknown>>,
    specificWebhook?: WebhookEndpointRecord,
  ): Promise<number> {
    const targets = specificWebhook
      ? [specificWebhook]
      : store.listMatchingWebhooks(tenantId, eventType);

    for (const wh of targets) {
      const deliveryId = store.generateId('del');
      const payload: WebhookJobPayload = {
        deliveryId,
        tenantId,
        webhookId: wh.id,
        webhookName: wh.name,
        targetUrl: wh.targetUrl,
        eventType,
        data,
      };
      const job = await queue.enqueue('webhook.deliver', payload, {
        maxAttempts: 2,
        backoff: { type: 'fixed', delayMs: 60 },
      });
      store.upsertDelivery({
        id: deliveryId,
        jobId: job.id,
        tenantId,
        webhookId: wh.id,
        webhookName: wh.name,
        targetUrl: wh.targetUrl,
        eventType,
        status: 'queued',
        attempts: 0,
        maxAttempts: job.maxAttempts,
        payloadPreview: data,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
    }
    return targets.length;
  }

  return {
    enqueueMatching,

    async listForTenant(identity: AuthIdentity): Promise<ListWebhooksResult> {
      const tenantId = identity.tenantId;
      if (!tenantId) {
        throw new ForbiddenError('Tenant context required');
      }

      const endpoints = store.listWebhooksForTenant(tenantId);
      const deliveries = store.listDeliveriesForTenant(tenantId);
      const allDlq = await queue.getDeadLetters();
      const deadLetters = allDlq
        .filter((job) => {
          const payload = job.payload as Partial<WebhookJobPayload> | undefined;
          return payload?.tenantId === tenantId;
        })
        .map((job) => ({
          id: job.id,
          name: job.name,
          attempts: job.attempts,
          maxAttempts: job.maxAttempts,
          lastError: job.lastError ?? 'Delivery failed',
          payload: job.payload,
          createdAt: new Date(job.createdAt).toISOString(),
        }));

      return {
        endpoints,
        deliveries,
        deadLetters,
        queueStats: queue.stats(),
      };
    },

    async register(
      identity: AuthIdentity,
      input: RegisterWebhookInput,
    ): Promise<WebhookEndpointRecord> {
      const actor = toActor(identity);
      auth.authorizer.assertPermission(actor, 'webhooks:write');

      const tenantId = identity.tenantId;
      if (!tenantId) {
        throw new ForbiddenError('Tenant context required');
      }

      const validatedUrl = await validateWebhookTarget(input.targetUrl);

      const endpoint: WebhookEndpointRecord = {
        id: store.generateId('wh'),
        tenantId,
        name: input.name,
        targetUrl: validatedUrl,
        events: input.events,
        active: true,
        createdBy: identity.subject,
        createdAt: new Date().toISOString(),
      };
      store.webhooks.set(endpoint.id, endpoint);

      store.publishEvent({
        tenantId,
        type: 'webhook.created',
        actorName: auth.resolveActorName(identity),
        summary: `Registered webhook "${endpoint.name}" -> ${endpoint.targetUrl}`,
        data: { webhookId: endpoint.id, targetUrl: endpoint.targetUrl },
      });

      return endpoint;
    },

    remove(identity: AuthIdentity, webhookId: string): void {
      const actor = toActor(identity);
      auth.authorizer.assertPermission(actor, 'webhooks:delete');

      const existing = store.webhooks.get(webhookId);
      if (!existing) {
        throw new NotFoundError(`Webhook "${webhookId}" not found`);
      }
      assertTenantIsolation(actor, existing);
      store.webhooks.delete(existing.id);
    },

    async triggerTest(
      identity: AuthIdentity,
      webhookId: string,
    ): Promise<{ readonly webhook: WebhookEndpointRecord; readonly queueStats: QueueStats }> {
      const actor = toActor(identity);
      const existing = store.webhooks.get(webhookId);
      if (!existing) {
        throw new NotFoundError(`Webhook "${webhookId}" not found`);
      }
      assertTenantIsolation(actor, existing);

      await enqueueMatching(
        existing.tenantId,
        'webhook.test',
        {
          ping: true,
          triggeredBy: auth.resolveActorName(identity),
          sentAt: new Date().toISOString(),
        },
        existing,
      );

      return {
        webhook: existing,
        queueStats: queue.stats(),
      };
    },

    async replayDeadLetter(
      identity: AuthIdentity,
      jobId: string,
      overrideHealthySink?: boolean,
    ): Promise<{ readonly id: string; readonly status: string; readonly attempts: number }> {
      const actor = toActor(identity);
      auth.authorizer.assertPermission(actor, 'webhooks:replay');

      const deadLetters = await queue.getDeadLetters();
      const target = deadLetters.find((j) => j.id === jobId);
      if (!target) {
        throw new NotFoundError(`Dead-letter job "${jobId}" not found`);
      }
      const payload = target.payload as Partial<WebhookJobPayload>;
      assertTenantIsolation(actor, { tenantId: payload.tenantId ?? null });

      if (overrideHealthySink === true) {
        replayHealthyOverrides.add(target.id);
      }

      const replayed = await queue.replayDeadLetter(target.id);
      store.updateDeliveryByJobId(replayed.id, {
        status: 'queued',
        lastError: undefined,
      });

      store.publishEvent({
        tenantId: identity.tenantId!,
        type: 'webhook.replayed',
        actorName: auth.resolveActorName(identity),
        summary: `Replayed dead-letter job ${replayed.id}${overrideHealthySink ? ' (healthy sink override)' : ''}`,
        data: { jobId: replayed.id },
      });

      return {
        id: replayed.id,
        status: replayed.status,
        attempts: replayed.attempts,
      };
    },
  };
}
