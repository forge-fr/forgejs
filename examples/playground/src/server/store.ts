import crypto from 'node:crypto';
import { createToken } from '@forge-fr/core';
import type { PasswordHasher } from '@forge-fr/auth';
import type { StorageAdapter } from '@forge-fr/storage';
import {
  DEMO_SANDBOX_PASSWORD,
  SAMPLE_CROSS_TENANT_TASK_ID,
  TENANT_ACME_ID,
  TENANT_GLOBEX_ID,
  type DeliveryStatus,
  type PlaygroundRealtimeEvent,
  type TaskAttachmentRecord,
  type TaskPriority,
  type TaskRecord,
  type TaskStatus,
  type TenantRecord,
  type UserRecord,
  type WebhookDeliveryRecord,
  type WebhookEndpointRecord,
  type WebhookEventType,
} from './types.ts';

type EventSubscriber = (event: PlaygroundRealtimeEvent) => void;

export const PlaygroundStoreToken = createToken<PlaygroundStore>('playground:Store');

export class PlaygroundStore {
  public readonly tenants = new Map<string, TenantRecord>();
  public readonly users = new Map<string, UserRecord>();
  public readonly usersByEmail = new Map<string, string>();
  public readonly tasks = new Map<string, TaskRecord>();
  public readonly attachments = new Map<string, TaskAttachmentRecord>();
  public readonly webhooks = new Map<string, WebhookEndpointRecord>();
  public readonly deliveries = new Map<string, WebhookDeliveryRecord>();
  public readonly deliveryIdByJobId = new Map<string, string>();
  public readonly realtimeHistory: PlaygroundRealtimeEvent[] = [];

  private readonly subscribersByTenant = new Map<string, Set<EventSubscriber>>();
  private cachedDemoPasswordHash: string | null = null;
  private eventSeq = 0;

  public async seed(passwordHasher: PasswordHasher, storage: StorageAdapter): Promise<void> {
    this.tenants.clear();
    this.users.clear();
    this.usersByEmail.clear();
    this.tasks.clear();
    this.attachments.clear();
    this.webhooks.clear();
    this.deliveries.clear();
    this.deliveryIdByJobId.clear();
    this.realtimeHistory.length = 0;

    // Clear existing storage objects cleanly before re-seeding
    const existing = await storage.list({ limit: 500 });
    for (const obj of existing.objects) {
      await storage.delete(obj.key);
    }

    if (this.cachedDemoPasswordHash === null) {
      this.cachedDemoPasswordHash = await passwordHasher.hash(DEMO_SANDBOX_PASSWORD);
    }
    const demoHash = this.cachedDemoPasswordHash;
    const now = new Date();
    const hoursAgo = (h: number): string => new Date(now.getTime() - h * 3_600_000).toISOString();

    // Seed 2 isolated tenants
    this.tenants.set(TENANT_ACME_ID, {
      id: TENANT_ACME_ID,
      slug: 'acme',
      name: 'Acme Corp',
      plan: 'enterprise',
      createdAt: hoursAgo(72),
    });
    this.tenants.set(TENANT_GLOBEX_ID, {
      id: TENANT_GLOBEX_ID,
      slug: 'globex',
      name: 'Globex Labs',
      plan: 'growth',
      createdAt: hoursAgo(60),
    });

    // Seed 3 demo users across both tenants
    const seedUsers: UserRecord[] = [
      {
        id: 'user_acme_admin',
        tenantId: TENANT_ACME_ID,
        email: 'admin@acme.dev',
        name: 'Elena Vance',
        role: 'admin',
        passwordHash: demoHash,
        createdAt: hoursAgo(70),
      },
      {
        id: 'user_acme_member',
        tenantId: TENANT_ACME_ID,
        email: 'member@acme.dev',
        name: 'Marcus Chen',
        role: 'member',
        passwordHash: demoHash,
        createdAt: hoursAgo(50),
      },
      {
        id: 'user_globex_admin',
        tenantId: TENANT_GLOBEX_ID,
        email: 'admin@globex.dev',
        name: 'Nadia Okafor',
        role: 'admin',
        passwordHash: demoHash,
        createdAt: hoursAgo(58),
      },
    ];

    for (const user of seedUsers) {
      this.users.set(user.id, user);
      this.usersByEmail.set(user.email.toLowerCase(), user.id);
    }

    // Seed multi-tenant tasks
    const seedTasks: TaskRecord[] = [
      {
        id: 'task_acme_01',
        tenantId: TENANT_ACME_ID,
        createdBy: 'user_acme_admin',
        createdByName: 'Elena Vance',
        title: 'Harden webhook signature verification pipeline',
        description:
          'Verify HMAC-SHA256 headers and enforce outbound SSRF allowlists across all tenant webhook targets.',
        status: 'in_progress',
        priority: 'high',
        createdAt: hoursAgo(14),
        updatedAt: hoursAgo(2),
      },
      {
        id: 'task_acme_02',
        tenantId: TENANT_ACME_ID,
        createdBy: 'user_acme_member',
        createdByName: 'Marcus Chen',
        title: 'Audit single-flight cache invalidation tags',
        description:
          'Confirm tag-based eviction clears tenant list caches immediately after task creation and updates.',
        status: 'todo',
        priority: 'medium',
        createdAt: hoursAgo(9),
        updatedAt: hoursAgo(9),
      },
      {
        id: 'task_acme_03',
        tenantId: TENANT_ACME_ID,
        createdBy: 'user_acme_admin',
        createdByName: 'Elena Vance',
        title: 'Publish OpenAPI 3.1 schema for partner SDKs',
        description:
          'Expose validated Zod request/response contracts through /playground-api/openapi.json.',
        status: 'done',
        priority: 'low',
        createdAt: hoursAgo(24),
        updatedAt: hoursAgo(5),
      },
      {
        id: SAMPLE_CROSS_TENANT_TASK_ID,
        tenantId: TENANT_GLOBEX_ID,
        createdBy: 'user_globex_admin',
        createdByName: 'Nadia Okafor',
        title: 'Rotate HSM signing keys in EU-Central cluster',
        description:
          'Confidential Globex Labs operational task — strictly isolated from Acme Corp tokens.',
        status: 'in_progress',
        priority: 'high',
        createdAt: hoursAgo(12),
        updatedAt: hoursAgo(1),
      },
      {
        id: 'task_globex_02',
        tenantId: TENANT_GLOBEX_ID,
        createdBy: 'user_globex_admin',
        createdByName: 'Nadia Okafor',
        title: 'Enable Postgres readiness probe timeout alerts',
        description:
          'Verify /health/ready returns sanitized status within 500ms budget.',
        status: 'todo',
        priority: 'medium',
        createdAt: hoursAgo(6),
        updatedAt: hoursAgo(6),
      },
    ];

    for (const task of seedTasks) {
      this.tasks.set(task.id, task);
    }

    // Seed 1 validated attachment in @forge-fr/storage for task_acme_01
    const sampleNotes = [
      '# ForgeJS Live Playground — Security Verification Checklist',
      '',
      '1. Argon2id password hashes & HS256 JWT authentication (@forge-fr/auth)',
      '2. Multi-tenant isolation & RBAC/ownership checks (@forge-fr/authorization)',
      '3. Tag-invalidated single-flight caching (@forge-fr/cache)',
      '4. Async webhook delivery with retries & Dead-Letter Queue (@forge-fr/queue)',
      '5. Binary magic-byte validation & path confinement (@forge-fr/storage)',
    ].join('\n');
    const storageKey = `${TENANT_ACME_ID}/task_acme_01/att_acme_01-security-checklist.txt`;
    const storedMeta = await storage.put(storageKey, sampleNotes, {
      contentType: 'text/plain',
      metadata: {
        tenantId: TENANT_ACME_ID,
        taskId: 'task_acme_01',
      },
    });
    this.attachments.set('att_acme_01', {
      id: 'att_acme_01',
      tenantId: TENANT_ACME_ID,
      taskId: 'task_acme_01',
      storageKey: storedMeta.key,
      filename: 'security-checklist.txt',
      mimeType: storedMeta.contentType,
      sizeBytes: storedMeta.size,
      etag: storedMeta.etag,
      uploadedBy: 'user_acme_admin',
      createdAt: hoursAgo(4),
    });

    // Seed webhooks for both tenants
    const seedWebhooks: WebhookEndpointRecord[] = [
      {
        id: 'wh_acme_ok',
        tenantId: TENANT_ACME_ID,
        name: 'Acme Ops Notification Sink',
        targetUrl: 'sandbox://sink/ok',
        events: ['task.created', 'task.completed', 'attachment.uploaded', 'webhook.test'],
        active: true,
        createdBy: 'user_acme_admin',
        createdAt: hoursAgo(30),
      },
      {
        id: 'wh_acme_fail',
        tenantId: TENANT_ACME_ID,
        name: 'Acme Failing Legacy Receiver (DLQ Demo)',
        targetUrl: 'sandbox://sink/fail',
        events: ['webhook.test'],
        active: true,
        createdBy: 'user_acme_admin',
        createdAt: hoursAgo(18),
      },
      {
        id: 'wh_globex_ok',
        tenantId: TENANT_GLOBEX_ID,
        name: 'Globex SIEM Event Collector',
        targetUrl: 'sandbox://sink/ok',
        events: ['task.created', 'task.completed', 'webhook.test'],
        active: true,
        createdBy: 'user_globex_admin',
        createdAt: hoursAgo(20),
      },
    ];

    for (const wh of seedWebhooks) {
      this.webhooks.set(wh.id, wh);
    }

    // Seed one completed delivery history item so the UI table opens populated
    this.deliveries.set('del_seed_01', {
      id: 'del_seed_01',
      jobId: 'seed_job_01',
      tenantId: TENANT_ACME_ID,
      webhookId: 'wh_acme_ok',
      webhookName: 'Acme Ops Notification Sink',
      targetUrl: 'sandbox://sink/ok',
      eventType: 'task.completed',
      status: 'delivered',
      attempts: 1,
      maxAttempts: 2,
      statusCode: 200,
      payloadPreview: {
        taskId: 'task_acme_03',
        title: 'Publish OpenAPI 3.1 schema for partner SDKs',
      },
      createdAt: hoursAgo(5),
      updatedAt: hoursAgo(5),
    });
  }

  public generateId(prefix: string): string {
    return `${prefix}_${crypto.randomBytes(6).toString('hex')}`;
  }

  public getTenant(tenantId: string): TenantRecord | undefined {
    return this.tenants.get(tenantId);
  }

  public getUserByEmail(email: string): UserRecord | undefined {
    const id = this.usersByEmail.get(email.trim().toLowerCase());
    return id ? this.users.get(id) : undefined;
  }

  public addUser(user: UserRecord): void {
    this.users.set(user.id, user);
    this.usersByEmail.set(user.email.trim().toLowerCase(), user.id);
  }

  public listTasksForTenant(
    tenantId: string,
    filters?: { status?: TaskStatus; priority?: TaskPriority; q?: string },
  ): TaskRecord[] {
    const q = filters?.q?.trim().toLowerCase();
    return Array.from(this.tasks.values())
      .filter((task) => {
        if (task.tenantId !== tenantId) return false;
        if (filters?.status && task.status !== filters.status) return false;
        if (filters?.priority && task.priority !== filters.priority) return false;
        if (
          q &&
          !task.title.toLowerCase().includes(q) &&
          !task.description.toLowerCase().includes(q) &&
          !task.id.toLowerCase().includes(q)
        ) {
          return false;
        }
        return true;
      })
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  public listAttachmentsForTask(tenantId: string, taskId: string): TaskAttachmentRecord[] {
    return Array.from(this.attachments.values())
      .filter((att) => att.tenantId === tenantId && att.taskId === taskId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  public listWebhooksForTenant(tenantId: string): WebhookEndpointRecord[] {
    return Array.from(this.webhooks.values())
      .filter((wh) => wh.tenantId === tenantId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  public listMatchingWebhooks(tenantId: string, eventType: WebhookEventType): WebhookEndpointRecord[] {
    return Array.from(this.webhooks.values()).filter(
      (wh) => wh.tenantId === tenantId && wh.active && wh.events.includes(eventType),
    );
  }

  public listDeliveriesForTenant(tenantId: string): WebhookDeliveryRecord[] {
    return Array.from(this.deliveries.values())
      .filter((d) => d.tenantId === tenantId)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, 50);
  }

  public upsertDelivery(record: WebhookDeliveryRecord): void {
    this.deliveries.set(record.id, record);
    this.deliveryIdByJobId.set(record.jobId, record.id);
  }

  public updateDeliveryByJobId(
    jobId: string,
    patch: Partial<{
      status: DeliveryStatus;
      attempts: number;
      statusCode: number | undefined;
      lastError: string | undefined;
    }>,
  ): WebhookDeliveryRecord | undefined {
    const deliveryId = this.deliveryIdByJobId.get(jobId);
    if (!deliveryId) return undefined;
    const current = this.deliveries.get(deliveryId);
    if (!current) return undefined;
    const updated: WebhookDeliveryRecord = {
      ...current,
      ...(patch.status !== undefined ? { status: patch.status } : {}),
      ...(patch.attempts !== undefined ? { attempts: patch.attempts } : {}),
      ...(patch.statusCode !== undefined ? { statusCode: patch.statusCode } : {}),
      ...(patch.lastError !== undefined ? { lastError: patch.lastError } : {}),
      updatedAt: new Date().toISOString(),
    };
    this.deliveries.set(deliveryId, updated);
    return updated;
  }

  public subscribe(tenantId: string, listener: EventSubscriber): () => void {
    let set = this.subscribersByTenant.get(tenantId);
    if (!set) {
      set = new Set<EventSubscriber>();
      this.subscribersByTenant.set(tenantId, set);
    }
    set.add(listener);
    return () => {
      set?.delete(listener);
      if (set && set.size === 0) {
        this.subscribersByTenant.delete(tenantId);
      }
    };
  }

  public publishEvent(
    input: Omit<PlaygroundRealtimeEvent, 'id' | 'timestamp'>,
  ): PlaygroundRealtimeEvent {
    this.eventSeq += 1;
    const event: PlaygroundRealtimeEvent = {
      ...input,
      id: `evt_${this.eventSeq}_${Date.now().toString(36)}`,
      timestamp: new Date().toISOString(),
    };
    this.realtimeHistory.unshift(event);
    if (this.realtimeHistory.length > 80) {
      this.realtimeHistory.length = 80;
    }

    const targets =
      input.tenantId === '*'
        ? Array.from(this.subscribersByTenant.values()).flatMap((s) => Array.from(s))
        : Array.from(this.subscribersByTenant.get(input.tenantId) ?? []);

    for (const listener of targets) {
      try {
        listener(event);
      } catch {
        // Ignore disconnected listener errors
      }
    }
    return event;
  }

  public getRecentEventsForTenant(tenantId: string, limit = 25): PlaygroundRealtimeEvent[] {
    return this.realtimeHistory
      .filter((e) => e.tenantId === tenantId || e.tenantId === '*')
      .slice(0, limit);
  }
}
