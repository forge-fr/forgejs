import { requireAuth } from '@forge-fr/auth';
import type { ForgeHttpApp } from '@forge-fr/http';
import { validatedOpenApiHandler } from '@forge-fr/openapi';
import { z } from 'zod';
import { requireBearerAuth } from '../auth/auth.middleware.ts';
import { TasksServiceToken } from './tasks.service.ts';

const TaskStatusSchema = z.enum(['todo', 'in_progress', 'done']);
const TaskPrioritySchema = z.enum(['low', 'medium', 'high']);

const ListTasksQuerySchema = z.object({
  status: TaskStatusSchema.optional(),
  priority: TaskPrioritySchema.optional(),
  q: z.string().max(100).optional(),
});

const CreateTaskBodySchema = z.object({
  title: z.string().trim().min(3, 'Title must be at least 3 characters').max(140),
  description: z.string().trim().max(1000).default(''),
  status: TaskStatusSchema.default('todo'),
  priority: TaskPrioritySchema.default('medium'),
});

const UpdateTaskBodySchema = z
  .object({
    title: z.string().trim().min(3).max(140).optional(),
    description: z.string().trim().max(1000).optional(),
    status: TaskStatusSchema.optional(),
    priority: TaskPrioritySchema.optional(),
  })
  .refine(
    (v) =>
      v.title !== undefined ||
      v.description !== undefined ||
      v.status !== undefined ||
      v.priority !== undefined,
    { message: 'Provide at least one field to update' },
  );

const IdParamSchema = z.object({
  id: z.string().min(1).max(80),
});

export function registerTasksController(app: ForgeHttpApp): void {
  app.group(
    '/playground-api/tasks',
    (group) => {
      group.get(
        '/',
        validatedOpenApiHandler(
          { query: ListTasksQuerySchema },
          async (ctx, { query }) => {
            const identity = requireAuth(ctx);
            const tasks = ctx.resolve(TasksServiceToken);
            const result = await tasks.list(identity, query);
            ctx.setHeader('x-cache-status', result.cache.status);
            ctx.setHeader('x-cache-key', result.cache.key);
            return ctx.json(result);
          },
          {
            summary: 'List tenant-scoped tasks with @forge-fr/cache tag caching (X-Cache-Status HIT/MISS)',
            tags: ['Tasks'],
          },
        ),
      );

      group.post(
        '/',
        validatedOpenApiHandler(
          { body: CreateTaskBodySchema },
          async (ctx, { body }) => {
            const identity = requireAuth(ctx);
            const tasks = ctx.resolve(TasksServiceToken);
            const result = await tasks.create(identity, body);
            return ctx.json(result, { status: 201 });
          },
          {
            summary: 'Create a tenant-scoped task, invalidate cache tags, broadcast SSE, and enqueue webhooks',
            tags: ['Tasks'],
          },
        ),
      );

      group.get(
        '/:id',
        validatedOpenApiHandler(
          { params: IdParamSchema },
          (ctx, { params }) => {
            const identity = requireAuth(ctx);
            const tasks = ctx.resolve(TasksServiceToken);
            return ctx.json(tasks.getById(identity, params.id));
          },
          {
            summary: 'Fetch a single task enforcing @forge-fr/authorization assertTenantIsolation',
            tags: ['Tasks'],
          },
        ),
      );

      group.patch(
        '/:id',
        validatedOpenApiHandler(
          { params: IdParamSchema, body: UpdateTaskBodySchema },
          async (ctx, { params, body }) => {
            const identity = requireAuth(ctx);
            const tasks = ctx.resolve(TasksServiceToken);
            const result = await tasks.update(identity, params.id, body);
            return ctx.json(result);
          },
          {
            summary: 'Update task enforcing tenant isolation and Admin-or-Owner ABAC policy',
            tags: ['Tasks'],
          },
        ),
      );

      group.delete(
        '/:id',
        validatedOpenApiHandler(
          { params: IdParamSchema },
          async (ctx, { params }) => {
            const identity = requireAuth(ctx);
            const tasks = ctx.resolve(TasksServiceToken);
            await tasks.remove(identity, params.id);
            return ctx.json({ deleted: true, taskId: params.id });
          },
          {
            summary: 'Delete a task and cascade-delete its @forge-fr/storage attachments',
            tags: ['Tasks'],
          },
        ),
      );
    },
    { middleware: [requireBearerAuth] },
  );
}
