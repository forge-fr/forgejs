import { createToken } from '@forge-fr/core';
import type { AuthMiddlewareOptions, JwtService, PasswordHasher } from '@forge-fr/auth';
import type { Authorizer } from '@forge-fr/authorization';
import type { MemoryLogSink } from '@forge-fr/logger';

export type UserRole = 'admin' | 'member';
export type TaskStatus = 'todo' | 'in_progress' | 'done';
export type TaskPriority = 'low' | 'medium' | 'high';
export type WebhookEventType =
  | 'task.created'
  | 'task.updated'
  | 'task.completed'
  | 'task.deleted'
  | 'attachment.uploaded'
  | 'webhook.test';

export type DeliveryStatus = 'queued' | 'delivered' | 'retrying' | 'dlq';

export interface TenantRecord {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly plan: 'enterprise' | 'growth' | 'starter';
  readonly createdAt: string;
}

export interface UserRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly email: string;
  readonly name: string;
  readonly role: UserRole;
  readonly passwordHash: string;
  readonly createdAt: string;
}

export interface PublicUser {
  readonly id: string;
  readonly tenantId: string;
  readonly email: string;
  readonly name: string;
  readonly role: UserRole;
  readonly createdAt: string;
}

export interface TaskRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly createdBy: string;
  readonly createdByName: string;
  readonly title: string;
  readonly description: string;
  readonly status: TaskStatus;
  readonly priority: TaskPriority;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface TaskAttachmentRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly taskId: string;
  readonly storageKey: string;
  readonly filename: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly etag: string;
  readonly uploadedBy: string;
  readonly createdAt: string;
}

export interface WebhookEndpointRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly name: string;
  readonly targetUrl: string;
  readonly events: readonly WebhookEventType[];
  readonly active: boolean;
  readonly createdBy: string;
  readonly createdAt: string;
}

export interface WebhookDeliveryRecord {
  readonly id: string;
  readonly jobId: string;
  readonly tenantId: string;
  readonly webhookId: string;
  readonly webhookName: string;
  readonly targetUrl: string;
  readonly eventType: WebhookEventType;
  readonly status: DeliveryStatus;
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly statusCode?: number;
  readonly lastError?: string;
  readonly payloadPreview: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface WebhookJobPayload {
  readonly deliveryId: string;
  readonly tenantId: string;
  readonly webhookId: string;
  readonly webhookName: string;
  readonly targetUrl: string;
  readonly eventType: WebhookEventType;
  readonly forceHealthySink?: boolean;
  readonly data: Readonly<Record<string, unknown>>;
}

export interface PlaygroundRealtimeEvent {
  readonly id: string;
  readonly tenantId: string;
  readonly type:
    | 'connected'
    | 'task.created'
    | 'task.updated'
    | 'task.completed'
    | 'task.deleted'
    | 'attachment.uploaded'
    | 'attachment.deleted'
    | 'webhook.created'
    | 'webhook.delivered'
    | 'webhook.retrying'
    | 'webhook.dlq'
    | 'webhook.replayed'
    | 'ws.broadcast'
    | 'security.probe'
    | 'health.fault'
    | 'sandbox.reset';
  readonly actorName: string;
  readonly summary: string;
  readonly data: Readonly<Record<string, unknown>>;
  readonly timestamp: string;
}

export interface DemoPersonaInfo {
  readonly id: string;
  readonly label: string;
  readonly tenantId: string;
  readonly tenantName: string;
  readonly tenantPlan: TenantRecord['plan'];
  readonly email: string;
  readonly name: string;
  readonly role: UserRole;
  readonly description: string;
}

export const TENANT_ACME_ID = 'tenant_acme';
export const TENANT_GLOBEX_ID = 'tenant_globex';
export const SAMPLE_CROSS_TENANT_TASK_ID = 'task_globex_01';

export const ALLOWED_SANDBOX_SINKS = new Set([
  'sandbox://sink/ok',
  'sandbox://sink/fail',
  'sandbox://sink/flaky',
]);

/**
 * Deterministic sandbox demo credentials for one-click persona sign-in.
 * Users can also register custom accounts via POST /playground-api/auth/register.
 */
export const DEMO_SANDBOX_PASSWORD = 'ForgeDemo!2026';

export const DEMO_PERSONAS: readonly DemoPersonaInfo[] = Object.freeze([
  {
    id: 'user_acme_admin',
    label: 'Acme Admin',
    tenantId: TENANT_ACME_ID,
    tenantName: 'Acme Corp',
    tenantPlan: 'enterprise',
    email: 'admin@acme.dev',
    name: 'Elena Vance',
    role: 'admin',
    description: 'Full tenant admin for Acme Corp (tasks, webhooks, DLQ replay, attachments).',
  },
  {
    id: 'user_acme_member',
    label: 'Acme Member',
    tenantId: TENANT_ACME_ID,
    tenantName: 'Acme Corp',
    tenantPlan: 'enterprise',
    email: 'member@acme.dev',
    name: 'Marcus Chen',
    role: 'member',
    description: 'Standard member in Acme Corp (can manage own tasks; blocked from webhook admin).',
  },
  {
    id: 'user_globex_admin',
    label: 'Globex Admin',
    tenantId: TENANT_GLOBEX_ID,
    tenantName: 'Globex Labs',
    tenantPlan: 'growth',
    email: 'admin@globex.dev',
    name: 'Nadia Okafor',
    role: 'admin',
    description: 'Isolated admin in Globex Labs for verifying cross-tenant boundaries.',
  },
]);

export interface PlaygroundAuthRuntime {
  readonly passwordHasher: PasswordHasher;
  readonly jwtService: JwtService;
  readonly authorizer: Authorizer;
  readonly authMiddlewareOptions: AuthMiddlewareOptions;
}

export type SandboxResetHandler = () => Promise<void>;

export interface PlaygroundAuthConfig {
  readonly passwordHasher?: PasswordHasher | undefined;
  readonly jwtSecret?: string | undefined;
}

export const PlaygroundTokens = Object.freeze({
  LogSink: createToken<MemoryLogSink>('playground:LogSink'),
  ReplayHealthyOverrides: createToken<Set<string>>('playground:ReplayHealthyOverrides'),
  ResetSandbox: createToken<SandboxResetHandler>('playground:ResetSandbox'),
  AuthConfig: createToken<PlaygroundAuthConfig>('playground:AuthConfig'),
});

export function toPublicUser(user: UserRecord): PublicUser {
  return {
    id: user.id,
    tenantId: user.tenantId,
    email: user.email,
    name: user.name,
    role: user.role,
    createdAt: user.createdAt,
  };
}
