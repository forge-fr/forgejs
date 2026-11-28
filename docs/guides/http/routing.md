# Routing

> Fast static route lookup, path parameters with regex constraints, wildcards, nested route groups, and automatic 405 responses.

- **Section**: HTTP & API Development
- **Packages**: @forge-fr/router, @forge-fr/http
- **Version**: v1.0.0
- **Updated**: 2026-11-27
- **HTML URL**: https://github.com/forge-fr/forgejs/docs/http/routing
- **Markdown URL**: https://github.com/forge-fr/forgejs/docs/http/routing.md
- **Source**: https://github.com/forge-fr/forgejs/blob/main/docs/http-and-validation.md

## Static, parameterized, constrained, and wildcard routes

@forge-fr/router looks up exact static paths in constant O(1) time via an internal map, and matches dynamic URL parameters and regex rules using a fast Radix tree.

**File: `src/routes.ts`**

```ts
import { createHttpApp } from '@forge-fr/http';

const app = createHttpApp();

app.get('/health', (ctx) => ctx.json({ ok: true }));
app.get('/users/:id{\\d+}', (ctx) => ctx.json({ id: ctx.params.id }));
app.get('/files/*path', (ctx) => ctx.json({ path: ctx.params.path }));

app.group('/api/v1', (api) => {
  api.get('/status', (ctx) => ctx.json({ version: 'v1' }));
});
```

## Route groups, HEAD support & parameter safety

- Nest routes cleanly with app.group("/api/v1", (api) => ...) to share URL prefixes and middleware.
- Route params are stored in prototype-free objects and automatically reject unsafe names like __proto__ or constructor.
- HEAD requests (autoHead) and 405 Method Not Allowed responses with Allow headers work automatically.
- Accidental duplicate or conflicting routes throw RouteConflictError right when you register them.
