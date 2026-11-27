# Build a Production Modular Backend Step by Step

> Build the full opinionated modular ForgeJS backend step by step — from workspace setup and Kernel DI to auth strategies, OWASP security, caching, magic-byte storage, webhook queues with DLQ replay, SSE/WebSockets, OpenTelemetry, and OpenAPI 3.1.

- **Version**: v1.0.0-rc.1
- **Steps**: 9 interactive steps
- **HTML URL**: https://github.com/forge-fr/forgejs/docs/tutorials/playground-backend
- **Markdown URL**: https://github.com/forge-fr/forgejs/docs/tutorials/playground-backend.md
- **Live Playground**: https://github.com/forge-fr/forgejs/playground

## Step 01: Workspace Setup, ESM TypeScript & HTTP Runtime

*Scaffold the workspace and boot the server natively with @forge-fr/node*

- **Estimated time**: 5 min
- **Packages**: @forge-fr/cli, @forge-fr/node, @forge-fr/http
- **Module files**: `package.json`, `tsconfig.json`, `server.ts`
- **Playground verification tab**: https://github.com/forge-fr/forgejs/playground?tab=source

Every production ForgeJS backend runs on pure ECMAScript Modules (ESM) with strict TypeScript compiler checks enabled from day one.

Instead of wrapping an external framework, your entry file wires createNodeAdapter() directly to createHttpApp() and delegates SIGINT/SIGTERM draining to attachProcessShutdown().

### Key Architectural Highlights

- Pure ESM package configuration ("type": "module") and strict tsconfig rules (strict, exactOptionalPropertyTypes, noUncheckedIndexedAccess).
- createNodeAdapter({ trustHostHeader: true }) exposes native Node.js HTTP and WebSocket upgrades with zero third-party server wrappers.
- attachProcessShutdown(app, { exitOnComplete: true }) guarantees queued jobs and open connections drain cleanly on shutdown.

### Implementation Code

**1. Bootstrap CLI (`terminal`)**

```bash
# Scaffold a modular backend workspace
npx @forge-fr/cli@next new task-webhook-api --template modular --runtime node
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

- [ ] Inspect server.ts in the Backend Source viewer to confirm pure @forge-fr/node booting.
- [ ] Verify graceful shutdown closes both the HTTP listener and background queue worker.

## Step 02: Application Kernel, Typed Tokens & Opinionated Modules

*Organize domain features into isolated DI modules with defineModule()*

- **Estimated time**: 8 min
- **Packages**: @forge-fr/core, @forge-fr/http
- **Module files**: `src/playground-server/app.ts`, `src/playground-server/types.ts`
- **Playground verification tab**: https://github.com/forge-fr/forgejs/playground?tab=source

As backends grow, flat route files turn into circular dependency knots. The Playground backend uses ForgeJS opinionated modules: each domain folder owns its module wiring, service factory, and HTTP controller.

Cross-module communication flows exclusively through typed tokens (createToken<T>()) and explicit imports/exports declarations resolved by ApplicationKernel.

### Key Architectural Highlights

- Zero runtime reflection or experimental decorators — createToken<T>() preserves full static TypeScript inference.
- Plugins (createCachePlugin, createQueuePlugin, createStoragePlugin) extend container capabilities safely in topological boot order.
- Global middleware (correlation IDs, OpenTelemetry spans, security headers, rate limiting) wraps all domain controllers uniformly.

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

- [ ] Confirm every domain folder exports an explicit module token and never imports unexported internals.
- [ ] View the DI Module Topology inside Health & OpenAPI after inspecting Backend Source.

## Step 03: Multi-Tenant Store & Deterministic Seed Modeling

*Isolate tenant records and expose deterministic sandbox seed data*

- **Estimated time**: 6 min
- **Packages**: @forge-fr/core
- **Module files**: `src/playground-server/types.ts`, `src/playground-server/store.ts`
- **Playground verification tab**: https://github.com/forge-fr/forgejs/playground?tab=tasks

Every record in a multi-tenant SaaS backend carries a required tenantId field from creation. Modeling this explicitly at the type and store boundary guarantees queries and authorization checks never drop tenant scope.

Our Playground store hashes seed passwords with Argon2id and uploads starter attachment bytes during kernel.start() so the API boots ready for immediate verification and one-click resets.

### Key Architectural Highlights

- Strict readonly TypeScript interfaces distinguish internal UserRecord (with passwordHash) from PublicUser.
- Two isolated seed tenants (Acme Corp and Globex Labs) let you prove cross-tenant boundaries immediately.
- In production databases, swap the in-memory store token for @forge-fr/database, @forge-fr/drizzle, or @forge-fr/prisma with zero controller changes.

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
    // Hash seed user passwords with real Argon2id and seed sample tenant records
  }
}
```

### Verification Checklist

- [ ] Switch personas between Acme Admin and Globex Admin in the Playground top bar.
- [ ] Confirm task lists stay strictly scoped to the active persona tenant.

## Step 04: Authentication Strategies & RBAC/ABAC Policies

*Combine Argon2id, JWT, hashed sessions, API keys, OAuth2 PKCE, and tenant isolation*

- **Estimated time**: 10 min
- **Packages**: @forge-fr/auth, @forge-fr/authorization
- **Module files**: `src/playground-server/auth/auth.module.ts`, `src/playground-server/auth/auth.service.ts`, `src/playground-server/auth/auth.middleware.ts`, `src/playground-server/auth/auth.controller.ts`
- **Playground verification tab**: https://github.com/forge-fr/forgejs/playground?tab=auth_lab

Production APIs rarely rely on a single auth mechanism. Browser portals use HttpOnly cookies or short-lived Bearer JWTs, CLI tools use scoped API keys, and federated logins rely on OAuth2 PKCE.

@forge-fr/auth handles Argon2id hashing, JWT signing/verification, SHA-256 cookie/API key validation, and PKCE state generation, while @forge-fr/authorization enforces role permissions plus ABAC ownership and tenant isolation.

### Key Architectural Highlights

- Password hashing uses createPasswordHasher() with Argon2id defaults and constant-time comparison.
- Scoped API keys enforce least privilege (e.g., tasks:read without tasks:delete or webhooks:read).
- assertTenantIsolation() and admin-or-owner policies block IDOR and privilege escalation automatically.

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

- [ ] Mint an HttpOnly session cookie, rotate its refresh token, and call GET /auth/session-me.
- [ ] Create a tasks:read-only API key and confirm read succeeds while unauthorized mutations reject.
- [ ] Generate an OAuth2 PKCE authorize URL and verify state mismatch defense.

## Step 05: Security Middleware & Defense-in-Depth Labs

*Harden endpoints against CSRF, bursts, prototype pollution, SSRF, and path traversal*

- **Estimated time**: 9 min
- **Packages**: @forge-fr/security
- **Module files**: `src/playground-server/security/security.module.ts`, `src/playground-server/security/security.service.ts`, `src/playground-server/security/security.controller.ts`
- **Playground verification tab**: https://github.com/forge-fr/forgejs/playground?tab=security

Security controls must protect both the HTTP edge and application helpers. In this step you compose @forge-fr/security primitives directly into route middleware and domain validators.

Every dangerous sink—JSON parsing, outbound webhook URLs, and file path assembly—runs through defensive allowlist utilities before touching business logic.

### Key Architectural Highlights

- createRateLimitMiddleware() attaches standard RateLimit-Limit, RateLimit-Remaining, and Retry-After headers on 429 responses.
- createCsrfMiddleware() validates Fetch Metadata and X-CSRF-Token headers before accepting state-changing cookie requests.
- safeJsonParse() strips __proto__ / constructor keys, assertSafeOutboundUrl() blocks metadata IPs, and resolveConfinedPath() stops ../ traversal.

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

// 1. Prototype-pollution safe JSON parsing
const sanitized = safeJsonParse('{"role":"member","__proto__":{"isAdmin":true}}');

// 2. SSRF URL inspection (blocks loopback, RFC1918, and 169.254.169.254 metadata)
await assertSafeOutboundUrl(candidateUrl, { allowPrivateIps: false });

// 3. Filesystem path-confinement guard (rejects ../../etc/passwd)
const safeTarget = resolveConfinedPath('/srv/sandbox/uploads', requestedFilename);
```

### Verification Checklist

- [ ] Trigger 4 consecutive rate-limit probes in Security Lab to observe 200 OK followed by 429 + Retry-After.
- [ ] Run the CSRF, IDOR, SSRF, Path Traversal, and __proto__ probes and inspect blocked responses.

## Step 06: Validated Tasks Module & Tag-Invalidated Caching

*Validate HTTP schemas automatically and bust tenant caches via tags*

- **Estimated time**: 8 min
- **Packages**: @forge-fr/validation, @forge-fr/cache, @forge-fr/openapi
- **Module files**: `src/playground-server/tasks/tasks.module.ts`, `src/playground-server/tasks/tasks.service.ts`, `src/playground-server/tasks/tasks.controller.ts`
- **Playground verification tab**: https://github.com/forge-fr/forgejs/playground?tab=tasks

Controllers stay concise when schema parsing, error formatting, and OpenAPI metadata happen together via validatedOpenApiHandler().

Read queries cache results under composite tenant+filter keys tagged with tenant:<id>:tasks. Every create, update, or delete calls invalidateByTag() so stale reads never leak across mutations.

### Key Architectural Highlights

- Standard Schema support lets Zod schemas validate query, params, and JSON body before entering your handler.
- Cache lookup sets X-Cache-Status: MISS on first fetch and HIT on subsequent requests within TTL.
- Every mutation invalidates the tenant cache tag, emits an SSE event, and enqueues matching webhooks.

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

- [ ] Load Tasks twice and watch the cache indicator transition from MISS to HIT in the HTTP Inspector.
- [ ] Create or update a task and confirm cache invalidation immediately returns fresh MISS data.

## Step 07: Attachments Module & Magic-Byte Object Storage

*Verify uploaded binary signatures before storing files per tenant*

- **Estimated time**: 6 min
- **Packages**: @forge-fr/storage, @forge-fr/http
- **Module files**: `src/playground-server/attachments/attachments.module.ts`, `src/playground-server/attachments/attachments.service.ts`, `src/playground-server/attachments/attachments.controller.ts`
- **Playground verification tab**: https://github.com/forge-fr/forgejs/playground?tab=attachments

Trusting client-supplied file extensions or Content-Type headers exposes applications to disguised executables and stored XSS.

@forge-fr/storage inspects actual binary magic bytes during put() alongside size bounds and MIME allowlists, then serves downloads with nosniff and safe Content-Disposition headers.

### Key Architectural Highlights

- createMemoryStorageAdapter({ verifyMagicBytes: true, maxObjectBytes: 512 * 1024 }) blocks spoofed headers at the adapter boundary.
- Multipart parsing is size-bounded via ctx.body.multipart({ maxFiles: 1, maxFileBytes: 512 * 1024 }).
- Downloads emit x-content-type-options: nosniff and private cache headers after asserting tenant ownership.

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

- [ ] Upload a valid 1x1 PNG file in the Attachments tab and inspect its generated ETag and byte size.
- [ ] Upload a spoofed payload (e.g., plain text claiming image/png) and confirm magic-byte rejection.

## Step 08: Webhooks Module, Async Queue Worker & DLQ Replay

*Deliver outbound webhooks asynchronously with retries and dead-letter recovery*

- **Estimated time**: 9 min
- **Packages**: @forge-fr/queue, @forge-fr/security
- **Module files**: `src/playground-server/webhooks/webhooks.module.ts`, `src/playground-server/webhooks/webhooks.service.ts`, `src/playground-server/webhooks/webhooks.controller.ts`
- **Playground verification tab**: https://github.com/forge-fr/forgejs/playground?tab=webhooks

Task mutations should never block HTTP response latency waiting on slow webhook receivers. Instead, the webhooks service enqueues durable jobs processed concurrently by createQueueWorker().

Failed deliveries retry with configurable backoff and land in the Dead-Letter Queue (DLQ) after exhausting maxAttempts, ready for manual inspection and replay.

### Key Architectural Highlights

- createQueueWorker() exposes deterministic lifecycle callbacks: onCompleted, onFailed, and onDeadLetter.
- Admin-only endpoint guards + SSRF checks prevent non-admins or unsafe URLs from registering webhooks.
- Dead-letter jobs can be replayed directly from the API with optional healthy-sink override.

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

- [ ] Register a failing webhook (sandbox://sink/fail), trigger a test event, and confirm it transitions into the Dead-Letter Queue.
- [ ] Replay the failed DLQ job using the healthy sink override and verify 200 OK delivery.

## Step 09: Realtime SSE/WebSocket, Edge HTTP, Observability & OpenAPI 3.1

*Stream live room events, negotiate content, trace spans, and publish specs*

- **Estimated time**: 10 min
- **Packages**: @forge-fr/http, @forge-fr/logger, @forge-fr/openapi
- **Module files**: `src/playground-server/realtime/realtime.controller.ts`, `src/playground-server/system/observability.ts`, `src/playground-server/system/system.controller.ts`
- **Playground verification tab**: https://github.com/forge-fr/forgejs/playground?tab=events

Rounding out the backend, @forge-fr/http handles authenticated app.ws() rooms, Server-Sent Events (SSE), weak ETag conditional caching (304 Not Modified vs 200 OK), and RFC-compliant Accept header negotiation.

Simultaneously, @forge-fr/logger instruments OpenTelemetry HTTP spans alongside Pino logs correlated by x-request-id and x-trace-id, exposes /health/live and /health/ready Kubernetes probes, and @forge-fr/openapi auto-generates live OpenAPI 3.1 JSON.

### Key Architectural Highlights

- app.ws() authenticates handshakes with Bearer or query tokens before joining tenant-isolated rooms.
- createEtagMiddleware({ weak: true }) returns 304 Not Modified on matching If-None-Match and 200 OK once bumped.
- registerHealthRoutes() aggregates dependency checks (/health/ready flips between 200 ok and 503 unhealthy on fault injection).
- registerOpenApiRoutes() introspects every validatedOpenApiHandler route automatically at /openapi.json.

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
  version: '1.0.0-rc.1',
  specPath: '/playground-api/openapi.json',
  docsPath: '/playground-api/docs',
});
```

### Verification Checklist

- [ ] Connect the WebSocket client, send a live frame, and test ETag 304 Not Modified vs 200 OK after bumping.
- [ ] Inject a dependency fault in Health & OpenAPI and verify /health/ready flips from 200 ok to 503 unhealthy.
- [ ] Inspect live OpenTelemetry spans, PII-redacted Pino logs, and the generated OpenAPI 3.1 document.
