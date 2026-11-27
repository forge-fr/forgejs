import {
  createToken,
  ForbiddenError,
  NotFoundError,
} from '@forge-fr/core';
import type { AuthIdentity } from '@forge-fr/auth';
import { assertTenantIsolation } from '@forge-fr/authorization';
import type { CacheAdapter, CacheStats } from '@forge-fr/cache';
import type { StorageAdapter } from '@forge-fr/storage';
import { toActor, type AuthService } from '../auth/auth.service.ts';
import type { PlaygroundStore } from '../store.ts';
import type {
  TaskAttachmentRecord,
  TaskPriority,
  TaskRecord,
  TaskStatus,
  WebhookEventType,
} from '../types.ts';
import type { WebhooksService } from '../webhooks/webhooks.service.ts';

export interface ListTasksQuery {
  readonly status?: TaskStatus | undefined;
  readonly priority?: TaskPriority | undefined;
  readonly q?: string | undefined;
}

export interface ListTasksResult {
  readonly tasks: readonly TaskRecord[];
  readonly total: number;
  readonly cache: {
    readonly status: 'HIT' | 'MISS';
    readonly key: string;
    readonly stats: CacheStats;
  };
}

export interface CreateTaskInput {
  readonly title: string;
  readonly description: string;
  readonly status: TaskStatus;
  readonly priority: TaskPriority;
}

export interface UpdateTaskInput {
  readonly title?: string | undefined;
  readonly description?: string | undefined;
  readonly status?: TaskStatus | undefined;
  readonly priority?: TaskPriority | undefined;
}

export interface TasksService {
  list(identity: AuthIdentity, query: ListTasksQuery): Promise<ListTasksResult>;
  create(
    identity: AuthIdentity,
    input: CreateTaskInput,
  ): Promise<{
    readonly task: TaskRecord;
    readonly cacheInvalidatedEntries: number;
    readonly webhooksEnqueued: number;
  }>;
  getById(
    identity: AuthIdentity,
    taskId: string,
  ): { readonly task: TaskRecord; readonly attachments: readonly TaskAttachmentRecord[] };
  update(
    identity: AuthIdentity,
    taskId: string,
    input: UpdateTaskInput,
  ): Promise<{ readonly task: TaskRecord; readonly webhooksEnqueued: number }>;
  remove(identity: AuthIdentity, taskId: string): Promise<void>;
}

export const TasksServiceToken = createToken<TasksService>('playground:TasksService');

export interface TasksServiceDeps {
  readonly store: PlaygroundStore;
  readonly cache: CacheAdapter;
  readonly storage: StorageAdapter;
  readonly auth: AuthService;
  readonly webhooks: WebhooksService;
}

export function createTasksService(deps: TasksServiceDeps): TasksService {
  const { store, cache, storage, auth, webhooks } = deps;

  return {
    async list(identity: AuthIdentity, query: ListTasksQuery): Promise<ListTasksResult> {
      const tenantId = identity.tenantId;
      if (!tenantId) {
        throw new ForbiddenError('Authenticated actor missing tenant context');
      }

      const cacheKey = `tasks:${tenantId}:${query.status ?? 'all'}:${query.priority ?? 'all'}:${query.q ?? ''}`;
      const cached = await cache.get<TaskRecord[]>(cacheKey);

      if (cached !== undefined) {
        return {
          tasks: cached,
          total: cached.length,
          cache: { status: 'HIT', key: cacheKey, stats: cache.stats() },
        };
      }

      const tasks = store.listTasksForTenant(tenantId, {
        ...(query.status ? { status: query.status } : {}),
        ...(query.priority ? { priority: query.priority } : {}),
        ...(query.q ? { q: query.q } : {}),
      });

      await cache.set(cacheKey, tasks, {
        ttlMs: 30_000,
        tags: [`tenant:${tenantId}:tasks`, 'tasks'],
      });

      return {
        tasks,
        total: tasks.length,
        cache: { status: 'MISS', key: cacheKey, stats: cache.stats() },
      };
    },

    async create(identity: AuthIdentity, input: CreateTaskInput) {
      const actor = toActor(identity);
      auth.authorizer.assertPermission(actor, 'tasks:create');

      const tenantId = identity.tenantId;
      if (!tenantId) {
        throw new ForbiddenError('Tenant context required');
      }

      const now = new Date().toISOString();
      const actorName = auth.resolveActorName(identity);
      const task: TaskRecord = {
        id: store.generateId('task'),
        tenantId,
        createdBy: identity.subject,
        createdByName: actorName,
        title: input.title,
        description: input.description,
        status: input.status,
        priority: input.priority,
        createdAt: now,
        updatedAt: now,
      };
      store.tasks.set(task.id, task);

      const invalidated = await cache.invalidateTag(`tenant:${tenantId}:tasks`);

      store.publishEvent({
        tenantId,
        type: 'task.created',
        actorName,
        summary: `Created task "${task.title}"`,
        data: { taskId: task.id, priority: task.priority, status: task.status },
      });

      const enqueuedWebhooks = await webhooks.enqueueMatching(tenantId, 'task.created', {
        taskId: task.id,
        title: task.title,
        priority: task.priority,
        status: task.status,
        createdBy: actorName,
      });

      return {
        task,
        cacheInvalidatedEntries: invalidated,
        webhooksEnqueued: enqueuedWebhooks,
      };
    },

    getById(identity: AuthIdentity, taskId: string) {
      const actor = toActor(identity);
      const task = store.tasks.get(taskId);
      if (!task) {
        throw new NotFoundError(`Task "${taskId}" not found`);
      }

      assertTenantIsolation(actor, task);
      const attachments = store.listAttachmentsForTask(task.tenantId, task.id);
      return { task, attachments };
    },

    async update(identity: AuthIdentity, taskId: string, input: UpdateTaskInput) {
      const actor = toActor(identity);
      const existing = store.tasks.get(taskId);
      if (!existing) {
        throw new NotFoundError(`Task "${taskId}" not found`);
      }

      assertTenantIsolation(actor, existing);
      await auth.authorizer.assert(actor, 'tasks:mutate', existing);

      const updated: TaskRecord = {
        ...existing,
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.status !== undefined ? { status: input.status } : {}),
        ...(input.priority !== undefined ? { priority: input.priority } : {}),
        updatedAt: new Date().toISOString(),
      };
      store.tasks.set(updated.id, updated);

      await cache.invalidateTag(`tenant:${updated.tenantId}:tasks`);

      const actorName = auth.resolveActorName(identity);
      const becameCompleted = existing.status !== 'done' && updated.status === 'done';
      const eventType: WebhookEventType = becameCompleted ? 'task.completed' : 'task.updated';

      store.publishEvent({
        tenantId: updated.tenantId,
        type: eventType,
        actorName,
        summary: becameCompleted
          ? `Completed task "${updated.title}"`
          : `Updated task "${updated.title}" (${updated.status})`,
        data: { taskId: updated.id, status: updated.status, priority: updated.priority },
      });

      const enqueuedWebhooks = await webhooks.enqueueMatching(updated.tenantId, eventType, {
        taskId: updated.id,
        title: updated.title,
        status: updated.status,
        priority: updated.priority,
      });

      return {
        task: updated,
        webhooksEnqueued: enqueuedWebhooks,
      };
    },

    async remove(identity: AuthIdentity, taskId: string): Promise<void> {
      const actor = toActor(identity);
      const existing = store.tasks.get(taskId);
      if (!existing) {
        throw new NotFoundError(`Task "${taskId}" not found`);
      }

      assertTenantIsolation(actor, existing);
      await auth.authorizer.assert(actor, 'tasks:mutate', existing);

      store.tasks.delete(existing.id);

      const attachments = store.listAttachmentsForTask(existing.tenantId, existing.id);
      for (const att of attachments) {
        await storage.delete(att.storageKey);
        store.attachments.delete(att.id);
      }

      await cache.invalidateTag(`tenant:${existing.tenantId}:tasks`);

      store.publishEvent({
        tenantId: existing.tenantId,
        type: 'task.deleted',
        actorName: auth.resolveActorName(identity),
        summary: `Deleted task "${existing.title}"`,
        data: { taskId: existing.id },
      });

      await webhooks.enqueueMatching(existing.tenantId, 'task.deleted', {
        taskId: existing.id,
        title: existing.title,
      });
    },
  };
}
