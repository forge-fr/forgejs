# Your First Application

> Step-by-step typed backend combining createKernel(), defineModule(), validatedHandler(), security headers, and graceful shutdown.

- **Section**: Getting Started
- **Packages**: @forge-fr/core, @forge-fr/http, @forge-fr/validation, @forge-fr/security, @forge-fr/node
- **Version**: v1.0.0-rc.2
- **Updated**: 2026-11-26
- **HTML URL**: https://github.com/forge-fr/forgejs/docs/getting-started/first-application
- **Markdown URL**: https://github.com/forge-fr/forgejs/docs/getting-started/first-application.md
- **Source**: https://github.com/forge-fr/forgejs/blob/main/docs/quick-start.md

## Complete modular service

This end-to-end service defines a private module state store, exports a typed service token, mounts security headers, validates request and response contracts, and drains gracefully on SIGTERM.

**File: `src/app.ts`**

```ts
import { createKernel, createToken, defineModule } from '@forge-fr/core';
import { createHttpApp } from '@forge-fr/http';
import { createNodeAdapter, attachProcessShutdown } from '@forge-fr/node';
import { createSecurityHeadersMiddleware } from '@forge-fr/security';
import { validatedHandler } from '@forge-fr/validation';
import { z } from 'zod';

interface ProjectRecord {
  id: string;
  name: string;
  ownerId: string;
}

interface ProjectService {
  create(name: string, ownerId: string): ProjectRecord;
  list(): ProjectRecord[];
}

const ProjectServiceToken = createToken<ProjectService>('ProjectService');

const ProjectsModule = defineModule({
  name: 'projects',
  providers: [
    {
      token: ProjectServiceToken,
      scope: 'singleton',
      useFactory: () => {
        const records: ProjectRecord[] = [];
        return {
          create(name, ownerId) {
            const item = { id: crypto.randomUUID(), name, ownerId };
            records.push(item);
            return item;
          },
          list: () => [...records],
        };
      },
    },
  ],
  exports: [ProjectServiceToken],
});

const kernel = createKernel({ modules: [ProjectsModule] });
await kernel.start();

const app = createHttpApp({ container: kernel.container });
app.use(createSecurityHeadersMiddleware());

app.get('/api/projects', async (ctx) => {
  const projects = await ctx.container!.resolve(ProjectServiceToken);
  return ctx.json({ items: projects.list() });
});

app.post(
  '/api/projects',
  validatedHandler(
    {
      body: z.object({
        name: z.string().min(2).max(80),
        ownerId: z.string().min(1),
      }),
      response: z.object({
        id: z.string().uuid(),
        name: z.string(),
      }),
    },
    async (ctx, input) => {
      const projects = await ctx.container!.resolve(ProjectServiceToken);
      const created = projects.create(input.body.name, input.body.ownerId);
      // ownerId is automatically stripped by the response contract
      return ctx.json({ id: created.id, name: created.name }, { status: 201 });
    },
  ),
);

const server = await app.listen(createNodeAdapter(), { host: '127.0.0.1', port: 3000 });
attachProcessShutdown(server, { onShutdown: () => kernel.shutdown() });
```

## Recommended modular folder layout

Running forge new <name> --template modular generates a clean domain-first structure where each feature module owns its tokens, services, and route registration factory.

**File: `directory-tree`**

```bash
src/
├── index.ts                 # Runtime entrypoint (Node/Bun/Edge adapter + shutdown)
├── app.ts                   # createKernel() + createHttpApp() assembly
└── modules/
    └── tasks/
        ├── tasks.module.ts      # defineModule() + private & exported tokens
        ├── tasks.service.ts     # Pure domain logic (zero runtime globals)
        └── tasks.controller.ts  # Route registration + validatedHandler()
```

## Response contract stripping

> **SECURITY: Automatic PII Redaction on Response Schemas**
>
> When validatedHandler() receives a response schema, undeclared fields such as ownerId or internal database columns are stripped before JSON serialization. Schema mismatches fail closed with ResponseValidationError (HTTP 500, expose: false).
