# Your First Application

> Step-by-step backend app combining createKernel(), defineModule(), validatedHandler(), security headers, and clean shutdown.

- **Section**: Getting Started
- **Packages**: @forge-fr/core, @forge-fr/http, @forge-fr/validation, @forge-fr/security, @forge-fr/node
- **Version**: v1.0.0
- **Updated**: 2026-11-27
- **HTML URL**: https://github.com/forge-fr/forgejs/docs/getting-started/first-application
- **Markdown URL**: https://github.com/forge-fr/forgejs/docs/getting-started/first-application.md
- **Source**: https://github.com/forge-fr/forgejs/blob/main/docs/quick-start.md

## Complete modular service example

This complete service keeps its data store private inside a module, shares a typed service token, adds security headers, validates both incoming requests and outgoing responses, and shuts down cleanly on SIGTERM.

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
      // ownerId is automatically stripped by the response schema
      return ctx.json({ id: created.id, name: created.name }, { status: 201 });
    },
  ),
);

const server = await app.listen(createNodeAdapter(), { host: '127.0.0.1', port: 3000 });
attachProcessShutdown(server, { onShutdown: () => kernel.shutdown() });
```

## Recommended folder layout

Running forge new <name> --template modular creates a clean feature-based layout where each feature folder owns its tokens, business logic, and HTTP routes.

**File: `directory-tree`**

```bash
src/
├── index.ts                 # Server entry file (Node, Bun, or Edge adapter + shutdown)
├── app.ts                   # createKernel() + createHttpApp() setup
└── modules/
    └── tasks/
        ├── tasks.module.ts      # defineModule() + private & exported tokens
        ├── tasks.service.ts     # Core business logic (no runtime-specific globals)
        └── tasks.controller.ts  # HTTP routes + validatedHandler()
```

## Automatic cleanup of extra response fields

> **SECURITY: Prevent Accidental Data Leaks in Responses**
>
> When you pass a response schema to validatedHandler(), any extra fields not listed in the schema (such as ownerId or password hashes) are removed automatically before sending JSON. If the response does not match the schema, ForgeJS fails safely with an internal HTTP 500 error.
