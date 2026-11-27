# Controllers & Handlers

> Composition-first route registration factories resolving typed DI services via ctx.container and generated via forge generate controller.

- **Section**: HTTP & API Development
- **Packages**: @forge-fr/http, @forge-fr/core, @forge-fr/cli
- **Version**: v1.0.0-rc.1
- **Updated**: 2026-11-26
- **HTML URL**: https://github.com/forge-fr/forgejs/docs/http/controllers
- **Markdown URL**: https://github.com/forge-fr/forgejs/docs/http/controllers.md
- **Source**: https://github.com/forge-fr/forgejs/blob/main/docs/http-and-validation.md

## Composition-first controllers

Instead of decorator classes, ForgeJS encourages plain route-registration functions that accept ForgeHttpApp and resolve domain services from the request-scoped ctx.container.

**File: `src/modules/users/users.controller.ts`**

```ts
import type { ForgeHttpApp } from '@forge-fr/http';
import { NotFoundError } from '@forge-fr/core';
import { UserServiceToken } from './users.module.js';

export function registerUserRoutes(app: ForgeHttpApp): void {
  app.group('/users', (users) => {
    users.get('/:id', async (ctx) => {
      const service = ctx.container!.resolve(UserServiceToken);
      const user = await service.findById(ctx.params.id!);
      if (!user) throw new NotFoundError('User not found');
      return ctx.json(user);
    });
  });
}
```

## Generating controllers with @forge-fr/cli

**File: `terminal`**

```bash
forge generate module users
forge generate controller users
forge generate service users
```
