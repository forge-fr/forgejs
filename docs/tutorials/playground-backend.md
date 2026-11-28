# Build a Production Modular Backend Step by Step

> Build the full opinionated modular ForgeJS backend step by step — from workspace setup and Kernel DI to auth strategies, OWASP security, caching, magic-byte storage, webhook queues with DLQ replay, SSE/WebSockets, OpenTelemetry, and OpenAPI 3.1.

- **Version**: v1.0.0
- **Steps**: 9 interactive steps
- **HTML URL**: https://github.com/forge-fr/forgejs/docs/tutorials/playground-backend
- **Markdown URL**: https://github.com/forge-fr/forgejs/docs/tutorials/playground-backend.md
- **Live Playground**: https://github.com/forge-fr/forgejs/playground

## Step 01: Project Setup, Strict TypeScript & Node Runtime

*Create the workspace and start the server cleanly with @forge-fr/node*

- **Estimated time**: 5 min
- **Packages**: @forge-fr/cli, @forge-fr/node, @forge-fr/http
- **Module files**: `package.json`, `tsconfig.json`, `server.ts`
- **Playground verification tab**: https://github.com/forge-fr/forgejs/playground?tab=source

Every ForgeJS backend uses modern JavaScript modules (ESM) and strict TypeScript settings from day one so type mistakes are caught before deployment.

Your entry file connects createNodeAdapter() directly to createHttpApp() and wires attachProcessShutdown() so open requests and background jobs finish safely when the server stops.

### Key Architectural Highlights

- Uses modern ESM ("type": "module") with strict TypeScript compiler checks.
- createNodeAdapter({ trustHostHeader: true }) runs directly on native Node.js HTTP and WebSockets with no extra server wrapper.
- attachProcessShutdown(app, { exitOnComplete: true }) ensures active requests and queued jobs drain cleanly on SIGINT or SIGTERM.

### Implementation Code

**1. Bootstrap CLI (`terminal`)**

```bash
# Configure GitHub Packages registry for @forge-fr/*
echo "@forge-fr:registry=https://npm.pkg.github.com" >> .npmrc

# Create a modular backend workspace
npx @forge-fr/cli new task-webhook-api --template modular --runtime node
cd task-webhook-api

# Install ForgeJS domain, security, cache, queue, storage, and OpenAPI packages
npm install @forge-fr/core @forge-fr/http @forge-fr/node @forge-fr/validation \
  @forge-fr/auth @forge-fr/authorization @forge-fr/security \
  @forge-fr/cache @forge-fr/queue @forge-fr/storage \
  @forge-fr/logger @forge-fr/openapi zod @opentelemetry/api
```

**2. Node Runtime Entry (`server.ts`)**

```ts
import { attachProcessShutdown, createNodeAdapter } from '@forge-fr/node';
import { createPlaygroundBackend } from './src/playground-server/app.ts';

const PORT = Number(process.env['PORT'] ?? 3000);
const HOST = '0.0.0.0';

async function startServer(): Promise<void> {
  const backend = createPlaygroundBackend({
    adapter: createNodeAdapter({
      trustHostHeader: true,
    }),
  });

  await backend.start();

  const address = await backend.app.listen({ host: HOST, port: PORT });
  console.log(`ForgeJS backend listening on ${address.url}`);

  attachProcessShutdown(backend.app, {
    exitOnComplete: true,
    onShutdown: async () => {
      await backend.close();
    },
  });
}

void startServer();
```

### Verification Checklist

- [ ] Open server.ts in the Backend Source viewer to see how @forge-fr/node starts the server.
- [ ] Confirm the shutdown handler closes both the HTTP server and the background job worker.

## Step 02: App Kernel, Typed Tokens & Feature Modules

*Group each backend feature into a clean module with defineModule()*

- **Estimated time**: 8 min
- **Packages**: @forge-fr/core, @forge-fr/http
- **Module files**: `src/playground-server/app.ts`, `src/playground-server/types.ts`
- **Playground verification tab**: https://github.com/forge-fr/forgejs/playground?tab=source

As an API grows, putting all routes in one file quickly turns into messy cross-imports. The Playground backend uses ForgeJS feature modules: each folder owns its module setup, service logic, and HTTP routes.

Modules talk to each other only through typed tokens (createToken<T>()) and explicit exports, keeping boundaries clear and easy to test.

### Key Architectural Highlights

- No class decorators or reflection magic — createToken<T>() keeps full TypeScript type checking.
- Plugins (cache, queue, storage) boot in dependency order and shut down in exact reverse order.
- Global middleware adds request IDs, OpenTelemetry tracing, security headers, and rate limits across every route.

### Implementation Code

**app.ts Composition Root (`src/playground-server/app.ts`)**

```ts
import { createHttpApp } from '@forge-fr/http';
import { createCachePlugin } from '@forge-fr/cache';
import { createQueuePlugin } from '@forge-fr/queue';
import { createStoragePlugin } from '@forge-fr/storage';
import { createRateLimitMiddleware, createSecurityHeadersMiddleware } from '@forge-fr/security';
import { authModule } from './auth/auth.module.ts';
import { tasksModule } from './tasks/tasks.module.ts';
import { webhooksModule } from './webhooks/webhooks.module.ts';
import { attachmentsModule } from './attachments/attachments.module.ts';

const app = createHttpApp({
  logger,
  providers: [
    { token: PlaygroundStoreToken, useValue: store },
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
    createQueuePlugin({ queue, worker, drainTimeoutMs: 2_000 }),
    createStoragePlugin({ adapter: storage }),
  ],
});

app.use(createSecurityHeadersMiddleware({ contentTypeOptions: 'nosniff', frameOptions: 'SAMEORIGIN' }));
app.use(createRateLimitMiddleware({ max: 300, windowMs: 60_000 }));
```

**Feature Module Contract (`src/playground-server/tasks/tasks.module.ts`)**

```ts
import { defineModule } from '@forge-fr/core';
import { CacheTokens } from '@forge-fr/cache';
import { StorageTokens } from '@forge-fr/storage';
import { authModule } from '../auth/auth.module.ts';
import { AuthServiceToken } from '../auth/auth.service.ts';
import { webhooksModule } from '../webhooks/webhooks.module.ts';
import { WebhooksServiceToken } from '../webhooks/webhooks.service.ts';
import { PlaygroundStoreToken } from '../store.ts';
import { TasksServiceToken, createTasksService } from './tasks.service.ts';

export const tasksModule = defineModule({
  name: 'tasks',
  imports: [authModule, webhooksModule],
  providers: [
    {
      token: TasksServiceToken,
      scope: 'singleton',
      useFactory: (resolver) =>
        createTasksService({
          store: resolver.resolve(PlaygroundStoreToken),
          cache: resolver.resolve(CacheTokens.Adapter),
          storage: resolver.resolve(StorageTokens.Adapter),
          auth: resolver.resolve(AuthServiceToken),
          webhooks: resolver.resolve(WebhooksServiceToken),
        }),
    },
  ],
  exports: [TasksServiceToken],
});
```

### Verification Checklist

- [ ] Confirm each feature folder exports a clear module token and hides its internal helpers.
- [ ] Open Health & OpenAPI after viewing Backend Source to see the loaded module graph.

## Step 03: Multi-Tenant Data Store & Predictable Seed Data

*Keep every workspace separated by tenantId with ready-to-test sample accounts*

- **Estimated time**: 6 min
- **Packages**: @forge-fr/core
- **Module files**: `src/playground-server/types.ts`, `src/playground-server/store.ts`
- **Playground verification tab**: https://github.com/forge-fr/forgejs/playground?tab=tasks

In a multi-tenant SaaS app, every record belongs to a workspace (tenantId). Putting tenantId right on your TypeScript types and store methods makes sure queries never mix data between customers.

During startup, the Playground store hashes demo passwords securely and adds starter files so you can test every feature right away or reset the sandbox with one click.

### Key Architectural Highlights

- Separate TypeScript types keep internal fields like passwordHash away from public user responses.
- Two separate demo companies (Acme Corp and Globex Labs) let you test tenant isolation immediately.
- In production, you can swap the in-memory store token for @forge-fr/database, @forge-fr/drizzle, or @forge-fr/prisma without changing your routes.

### Implementation Code

**Domain Entities (`src/playground-server/types.ts`)**

```ts
export type UserRole = 'admin' | 'member';
export type TaskStatus = 'todo' | 'in_progress' | 'done';
export type TaskPriority = 'low' | 'medium' | 'high';

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

export const TENANT_ACME_ID = 'tenant_acme';
export const TENANT_GLOBEX_ID = 'tenant_globex';
export const SAMPLE_CROSS_TENANT_TASK_ID = 'task_globex_01';
```

**Store Token & Seeding (`src/playground-server/store.ts`)**

```ts
import { createToken } from '@forge-fr/core';
import type { PasswordHasher } from '@forge-fr/auth';
import type { StorageAdapter } from '@forge-fr/storage';

export const PlaygroundStoreToken = createToken<PlaygroundStore>('playground:Store');

export class PlaygroundStore {
  private readonly tenants = new Map<string, TenantRecord>();
  private readonly users = new Map<string, UserRecord>();
  private readonly tasks = new Map<string, TaskRecord>();

  async seed(hasher: PasswordHasher, storage: StorageAdapter): Promise<void> {
    this.tenants.clear();
    this.users.clear();
    this.tasks.clear();
    // Hash seed user passwords with Argon2id and create starter tenant records
  }
}
```

### Verification Checklist

- [ ] Switch users between Acme Admin and Globex Admin in the Playground top bar.
- [ ] Confirm each user only sees tasks belonging to their own workspace.

## Step 04: Login Methods, Roles & Tenant Access Rules

*Support passwords, JWTs, HttpOnly cookies, scoped API keys, OAuth2 PKCE, and ownership checks*

- **Estimated time**: 10 min
- **Packages**: @forge-fr/auth, @forge-fr/authorization
- **Module files**: `src/playground-server/auth/auth.module.ts`, `src/playground-server/auth/auth.service.ts`, `src/playground-server/auth/auth.middleware.ts`, `src/playground-server/auth/auth.controller.ts`
- **Playground verification tab**: https://github.com/forge-fr/forgejs/playground?tab=auth_lab

Real backends often need more than one login method: browser apps use HttpOnly cookies or Bearer JWTs, CLI tools use scoped API keys, and social/SSO logins use OAuth2 PKCE.

@forge-fr/auth handles strong Argon2id password hashing, JWT verification, hashed sessions, API keys, and OAuth2 PKCE, while @forge-fr/authorization checks roles, record ownership, and tenant isolation.

### Key Architectural Highlights

- createPasswordHasher() uses safe Argon2id defaults and constant-time checks.
- Scoped API keys limit access strictly (for example, allowing tasks:read while blocking deletes).
- assertTenantIsolation() and ownership rules block cross-tenant snooping (IDOR) automatically.

### Implementation Code

**Auth & Policy Engine (`src/playground-server/auth/auth.service.ts`)**

```ts
import {
  createJwtService,
  createPasswordHasher,
  createSessionManager,
  createApiKeyService,
  createOAuth2Client,
} from '@forge-fr/auth';
import {
  assertTenantIsolation,
  createAuthorizer,
} from '@forge-fr/authorization';

const passwordHasher = createPasswordHasher();
const jwtService = createJwtService({
  algorithm: 'HS256',
  secret: process.env['JWT_SECRET'] ?? 'dev-secret-change-in-prod',
  issuer: 'forgejs-playground',
  audience: 'forgejs-api',
});

const authorizer = createAuthorizer({
  roles: {
    admin: ['tasks:read', 'tasks:create', 'tasks:update', 'tasks:delete', 'webhooks:manage'],
    member: ['tasks:read', 'tasks:create', 'tasks:update:own', 'tasks:delete:own'],
  },
});

export function assertTaskReadable(identity: AuthIdentity, task: TaskRecord): void {
  assertTenantIsolation(identity.tenantId, task.tenantId);
}
```

**Protected Route Group (`src/playground-server/auth/auth.middleware.ts`)**

```ts
import { createAuthMiddleware, extractBearerToken } from '@forge-fr/auth';
import type { ForgeMiddleware } from '@forge-fr/http';
import { AuthServiceToken } from './auth.service.ts';

export const requireBearerAuth: ForgeMiddleware = async (ctx, next) => {
  const auth = ctx.resolve(AuthServiceToken);
  const middleware = createAuthMiddleware({
    jwtService: auth.jwtService,
    extractToken: (reqCtx) => extractBearerToken(reqCtx.request),
  });
  return middleware(ctx, next);
};
```

### Verification Checklist

- [ ] Create an HttpOnly session cookie, rotate its refresh token, and call GET /auth/session-me.
- [ ] Create a read-only API key (tasks:read) and confirm reads pass while write attempts are rejected.
- [ ] Generate an OAuth2 PKCE login URL and test that a wrong state parameter is blocked.

## Step 05: Security Middleware & Attack Defenses

*Protect routes against CSRF, traffic bursts, JSON pollution, SSRF, and path escapes*

- **Estimated time**: 9 min
- **Packages**: @forge-fr/security
- **Module files**: `src/playground-server/security/security.module.ts`, `src/playground-server/security/security.service.ts`, `src/playground-server/security/security.controller.ts`
- **Playground verification tab**: https://github.com/forge-fr/forgejs/playground?tab=security

Good backend security protects both incoming HTTP requests and sensitive helpers inside your code. Here you plug @forge-fr/security middleware and safety helpers directly into your routes and services.

Every risky operation — parsing untrusted JSON, fetching user-supplied webhook URLs, or building file paths — passes through a safety check first.

### Key Architectural Highlights

- createRateLimitMiddleware() adds standard RateLimit-* and Retry-After headers when callers hit HTTP 429.
- createCsrfMiddleware() checks Fetch Metadata and X-CSRF-Token headers before accepting cookie-based mutations.
- safeJsonParse() strips __proto__ keys, assertSafeOutboundUrl() blocks private/metadata IPs, and resolveConfinedPath() stops ../ path escapes.

### Implementation Code

**Rate Limit & CSRF (`src/playground-server/security/security.controller.ts`)**

```ts
import { requireAuth } from '@forge-fr/auth';
import { createCsrfMiddleware, createRateLimitMiddleware } from '@forge-fr/security';
import { validatedOpenApiHandler } from '@forge-fr/openapi';

const demoRateLimit = createRateLimitMiddleware({
  store: security.demoRateLimitStore,
  max: 3,
  windowMs: 15_000,
  keyGenerator: (ctx) => `lab:${requireAuth(ctx).subject}`,
  message: 'Security Lab rate limit exceeded (3 requests per 15s window)',
});

const demoCsrf = createCsrfMiddleware({
  headerName: 'x-csrf-token',
  enforceFetchMetadata: true,
  getExpectedToken: (ctx) => security.getExpectedCsrfToken(requireAuth(ctx)),
});

group.get(
  '/rate-limit-probe',
  validatedOpenApiHandler({}, (ctx) => ctx.json({ allowed: true })),
  { middleware: [requireBearerAuth, demoRateLimit] },
);
```

**Input & Path Guards (`src/playground-server/security/security.service.ts`)**

```ts
import {
  assertSafeOutboundUrl,
  resolveConfinedPath,
  safeJsonParse,
} from '@forge-fr/security';

// 1. Safe JSON parsing (strips __proto__ / constructor keys)
const sanitized = safeJsonParse('{"role":"member","__proto__":{"isAdmin":true}}');

// 2. Outbound URL guard (blocks localhost, private IPs, and 169.254.169.254)
await assertSafeOutboundUrl(candidateUrl, { allowPrivateIps: false });

// 3. Confined file path helper (blocks ../../etc/passwd)
const safeTarget = resolveConfinedPath('/srv/sandbox/uploads', requestedFilename);
```

### Verification Checklist

- [ ] Click the rate-limit probe 4 times in Security Lab to see 200 OK followed by 429 + Retry-After.
- [ ] Run the CSRF, IDOR, SSRF, Path Traversal, and __proto__ probes and inspect the blocked responses.

## Step 06: Validated Task Routes & Tag-Based Caching

*Validate request inputs automatically and clear workspace caches by tag on writes*

- **Estimated time**: 8 min
- **Packages**: @forge-fr/validation, @forge-fr/cache, @forge-fr/openapi
- **Module files**: `src/playground-server/tasks/tasks.module.ts`, `src/playground-server/tasks/tasks.service.ts`, `src/playground-server/tasks/tasks.controller.ts`
- **Playground verification tab**: https://github.com/forge-fr/forgejs/playground?tab=tasks

Route handlers stay short and readable when validatedOpenApiHandler() takes care of input parsing, clean 400 validation errors, and OpenAPI docs in one step.

Task list reads are cached per workspace under a shared tag (tenant:<id>:tasks). Whenever a task is created, updated, or deleted, invalidateByTag() clears stale cache entries right away.

### Key Architectural Highlights

- Zod schemas validate query params, URL params, and JSON bodies before your handler runs.
- Responses return X-Cache-Status: MISS on the first load and HIT on repeat loads within the TTL.
- Every write clears the tenant cache tag, sends a live SSE update, and queues matching webhooks.

### Implementation Code

**Tasks Controller (`src/playground-server/tasks/tasks.controller.ts`)**

```ts
import { requireAuth } from '@forge-fr/auth';
import { validatedOpenApiHandler } from '@forge-fr/openapi';
import { z } from 'zod';
import { TasksServiceToken } from './tasks.service.ts';

const CreateTaskSchema = z.object({
  title: z.string().trim().min(3).max(140),
  description: z.string().trim().max(1000).default(''),
  status: z.enum(['todo', 'in_progress', 'done']).default('todo'),
  priority: z.enum(['low', 'medium', 'high']).default('medium'),
});

group.get(
  '/',
  validatedOpenApiHandler({ query: ListTasksQuerySchema }, async (ctx, { query }) => {
    const identity = requireAuth(ctx);
    const result = await ctx.resolve(TasksServiceToken).list(identity, query);
    ctx.setHeader('x-cache-status', result.cache.status);
    ctx.setHeader('x-cache-key', result.cache.key);
    return ctx.json(result);
  }),
);

group.post(
  '/',
  validatedOpenApiHandler({ body: CreateTaskSchema }, async (ctx, { body }) => {
    const identity = requireAuth(ctx);
    const created = await ctx.resolve(TasksServiceToken).create(identity, body);
    return ctx.json(created, { status: 201 });
  }),
);
```

**Tag-Scoped Cache Service (`src/playground-server/tasks/tasks.service.ts`)**

```ts
const tag = `tenant:${identity.tenantId}:tasks`;
const cacheKey = `${tag}:${statusFilter}:${searchQuery}`;

const cached = await cache.get<TaskListPayload>(cacheKey);
if (cached) {
  return { ...cached, cache: { status: 'HIT', key: cacheKey, tag } };
}

const items = store.listTasks(identity.tenantId, filters);
await cache.set(cacheKey, { tasks: items }, { ttlMs: 30_000, tags: [tag] });
return { tasks: items, cache: { status: 'MISS', key: cacheKey, tag } };

// On create / update / delete:
await cache.invalidateByTag(tag);
```

### Verification Checklist

- [ ] Load Tasks twice and watch X-Cache-Status switch from MISS to HIT in the HTTP Inspector.
- [ ] Create or edit a task and verify the next read refreshes cleanly with a MISS.

## Step 07: Safe File Uploads & Signature Checks

*Check real file bytes and size limits before saving tenant attachments*

- **Estimated time**: 6 min
- **Packages**: @forge-fr/storage, @forge-fr/http
- **Module files**: `src/playground-server/attachments/attachments.module.ts`, `src/playground-server/attachments/attachments.service.ts`, `src/playground-server/attachments/attachments.controller.ts`
- **Playground verification tab**: https://github.com/forge-fr/forgejs/playground?tab=attachments

Relying only on a filename extension or Content-Type header lets attackers disguise scripts or executables as safe images.

@forge-fr/storage checks the actual first bytes of each uploaded file (magic bytes), enforces file size and MIME limits, and serves downloads with safe nosniff headers.

### Key Architectural Highlights

- createMemoryStorageAdapter({ verifyMagicBytes: true, maxObjectBytes: 512 * 1024 }) rejects fake file types automatically.
- ctx.body.multipart({ maxFiles: 1, maxFileBytes: 512 * 1024 }) caps upload sizes while streaming.
- Downloads check tenant ownership and include x-content-type-options: nosniff.

### Implementation Code

**Storage Adapter Config (`src/playground-server/app.ts`)**

```ts
import { createMemoryStorageAdapter, createStoragePlugin } from '@forge-fr/storage';

const storage = createMemoryStorageAdapter({
  allowedMimeTypes: ['image/png', 'text/plain', 'application/json', 'application/pdf'],
  verifyMagicBytes: true,
  maxObjectBytes: 512 * 1024,
});

// Registered on createHttpApp plugins:
createStoragePlugin({ adapter: storage });
```

**Multipart Upload Handler (`src/playground-server/attachments/attachments.controller.ts`)**

```ts
group.post(
  '/',
  validatedOpenApiHandler({ params: IdParamSchema }, async (ctx, { params }) => {
    const identity = requireAuth(ctx);
    const multipart = await ctx.body.multipart({
      maxFiles: 1,
      maxFileBytes: 512 * 1024,
    });
    const uploaded = multipart.files[0];
    if (!uploaded) {
      throw new ValidationError('Multipart upload requires a file field named "file"');
    }

    const record = await ctx.resolve(AttachmentsServiceToken).upload(identity, {
      taskId: params.id,
      filename: uploaded.name || 'attachment.bin',
      mimeType: uploaded.type || 'application/octet-stream',
      bytes: new Uint8Array(await uploaded.arrayBuffer()),
    });

    return ctx.json({ attachment: record }, { status: 201 });
  }),
);
```

### Verification Checklist

- [ ] Upload a valid 1x1 PNG in the Attachments tab and check its ETag and byte size.
- [ ] Try uploading plain text disguised as image/png and verify ForgeJS rejects it.

## Step 08: Background Webhooks, Retries & Dead-Letter Replay

*Send outbound webhooks asynchronously with automatic retries and easy recovery*

- **Estimated time**: 9 min
- **Packages**: @forge-fr/queue, @forge-fr/security
- **Module files**: `src/playground-server/webhooks/webhooks.module.ts`, `src/playground-server/webhooks/webhooks.service.ts`, `src/playground-server/webhooks/webhooks.controller.ts`
- **Playground verification tab**: https://github.com/forge-fr/forgejs/playground?tab=webhooks

API writes should return quickly instead of waiting on slow third-party webhook servers. Here the webhooks service queues jobs so createQueueWorker() can deliver them in the background.

If delivery fails, the worker retries automatically. Jobs that fail every attempt move into the Dead-Letter Queue (DLQ), where admins can inspect and replay them later.

### Key Architectural Highlights

- createQueueWorker() provides clear callbacks: onCompleted, onFailed, and onDeadLetter.
- Admin permission checks and SSRF URL guards stop unauthorized users or unsafe targets from registering webhooks.
- Admins can replay dead-letter jobs from the API (with an optional healthy-sink override in the sandbox).

### Implementation Code

**Queue & Worker Setup (`src/playground-server/app.ts`)**

```ts
import { createMemoryQueueAdapter, createQueueWorker } from '@forge-fr/queue';

const queue = createMemoryQueueAdapter({
  maxQueueSize: 500,
  defaultMaxAttempts: 2,
  defaultBackoff: { type: 'fixed', delayMs: 60 },
});

const worker = createQueueWorker(
  queue,
  async (job, execCtx) => {
    const payload = job.payload as WebhookJobPayload;
    if (payload.targetUrl === 'sandbox://sink/fail') {
      throw new Error('502 Bad Gateway from failing sink');
    }
    if (payload.targetUrl === 'sandbox://sink/flaky' && execCtx.attempt === 1) {
      throw new Error('503 Service Unavailable on attempt 1');
    }
    return { delivered: true, statusCode: 200 };
  },
  {
    pollIntervalMs: 20,
    concurrency: 4,
    onCompleted: (job) => store.updateDeliveryByJobId(job.id, { status: 'delivered', statusCode: 200 }),
    onFailed: (job, err) => store.updateDeliveryByJobId(job.id, { status: 'retrying', lastError: String(err) }),
    onDeadLetter: (job, err) => store.updateDeliveryByJobId(job.id, { status: 'dlq', lastError: String(err) }),
  },
);
```

**Webhook Registration & Replay (`src/playground-server/webhooks/webhooks.controller.ts`)**

```ts
group.post(
  '/:id/test',
  validatedOpenApiHandler({ params: IdParamSchema }, async (ctx, { params }) => {
    const identity = requireAuth(ctx);
    const result = await ctx.resolve(WebhooksServiceToken).triggerTest(identity, params.id);
    return ctx.json(result, { status: 202 });
  }),
);

group.post(
  '/dlq/:jobId/replay',
  validatedOpenApiHandler(
    { params: JobIdParamSchema, body: ReplayBodySchema },
    async (ctx, { params, body }) => {
      const identity = requireAuth(ctx);
      const replayed = await ctx.resolve(WebhooksServiceToken).replayDeadLetter(
        identity,
        params.jobId,
        Boolean(body?.overrideHealthySink),
      );
      return ctx.json({ replayed });
    },
  ),
);
```

### Verification Checklist

- [ ] Register a failing webhook (sandbox://sink/fail), trigger a test event, and watch it move to the Dead-Letter Queue.
- [ ] Replay the failed DLQ job using the healthy sink override and confirm 200 OK delivery.

## Step 09: Real-Time Events, ETag Caching, Logs & OpenAPI 3.1

*Stream live updates, handle 304 caching, trace requests, and serve live API docs*

- **Estimated time**: 10 min
- **Packages**: @forge-fr/http, @forge-fr/logger, @forge-fr/openapi
- **Module files**: `src/playground-server/realtime/realtime.controller.ts`, `src/playground-server/system/observability.ts`, `src/playground-server/system/system.controller.ts`
- **Playground verification tab**: https://github.com/forge-fr/forgejs/playground?tab=events

To finish the backend, @forge-fr/http adds authenticated WebSocket rooms, Server-Sent Events (SSE), weak ETag 304 caching, and Accept header negotiation.

@forge-fr/logger connects OpenTelemetry traces with redacted Pino logs (linked by x-request-id and x-trace-id) and /health/live + /health/ready probes, while @forge-fr/openapi serves a live OpenAPI 3.1 spec.

### Key Architectural Highlights

- app.ws() checks Bearer or query tokens before letting clients join tenant-isolated rooms.
- createEtagMiddleware({ weak: true }) returns 304 Not Modified when content is unchanged and 200 OK after updates.
- registerHealthRoutes() checks registered dependencies (/health/ready switches from 200 ok to 503 unhealthy when a fault is injected).
- registerOpenApiRoutes() scans every validatedOpenApiHandler route automatically at /openapi.json.

### Implementation Code

**WebSocket & ETag Edge (`src/playground-server/realtime/realtime.controller.ts`)**

```ts
import { createEtagMiddleware, negotiateContentType } from '@forge-fr/http';

const etagMiddleware = createEtagMiddleware({ weak: true });

app.ws('/playground-api/ws', {
  async authenticate(ctx) {
    const token = extractBearerToken(ctx.request) ?? ctx.query['access_token'] ?? null;
    if (!token) return false;
    ctx.state.set('wsActor', await realtime.authorizeWsToken(token));
    return true;
  },
  onOpen(ws, ctx) {
    realtime.joinRoom(ws, ctx.state.get('wsActor') as WsActorMeta);
  },
  onMessage(ws, message) {
    realtime.handleRoomMessage(ws, message);
  },
  onClose(ws) {
    realtime.leaveRoom(ws);
  },
});

group.get(
  '/etag-resource',
  validatedOpenApiHandler({}, (ctx) => ctx.json(realtime.getEtagResource())),
  { middleware: [etagMiddleware] },
);
```

**Health, OTel & OpenAPI (`src/playground-server/app.ts`)**

```ts
import {
  createCorrelationIdMiddleware,
  createOtelHttpMiddleware,
  createRequestLoggingMiddleware,
  registerHealthRoutes,
} from '@forge-fr/logger';
import { registerOpenApiRoutes } from '@forge-fr/openapi';

kernel.health.register('demo_dependency', () =>
  observability.isFaultInjected()
    ? { status: 'unhealthy', message: 'Simulated dependency degradation' }
    : { status: 'ok', details: { mode: 'nominal' } },
);

app.use(createCorrelationIdMiddleware());
app.use(createOtelHttpMiddleware({ instrumentation: observability.instrumentation, exposeTraceIdHeader: true }));
app.use(createRequestLoggingMiddleware({ logger }));

registerHealthRoutes(app, {
  registry: kernel.health,
  livePath: '/playground-api/health/live',
  readyPath: '/playground-api/health/ready',
  exposeDetails: true,
});

registerOpenApiRoutes(app, {
  title: 'ForgeJS Live Playground API',
  version: '1.0.0',
  specPath: '/playground-api/openapi.json',
  docsPath: '/playground-api/docs',
});
```

### Verification Checklist

- [ ] Connect the WebSocket client, send a message, and test ETag 304 Not Modified vs 200 OK after bumping.
- [ ] Simulate a dependency failure in Health & OpenAPI and verify /health/ready switches from 200 ok to 503 unhealthy.
- [ ] Inspect live OpenTelemetry spans, redacted Pino logs, and the generated OpenAPI 3.1 JSON.
