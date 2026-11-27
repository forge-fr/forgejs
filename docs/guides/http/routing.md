# Routing

> O(1) static route lookup, constrained radix parameters, wildcards, nested groups, autoHead, and RFC 405 Allow generation.

- **Section**: HTTP & API Development
- **Packages**: @forge-fr/router, @forge-fr/http
- **Version**: v1.0.0-rc.2
- **Updated**: 2026-11-26
- **HTML URL**: https://github.com/forge-fr/forgejs/docs/http/routing
- **Markdown URL**: https://github.com/forge-fr/forgejs/docs/http/routing.md
- **Source**: https://github.com/forge-fr/forgejs/blob/main/docs/http-and-validation.md

## Static, parameterized, constrained, and wildcard routes

@forge-fr/router compiles exact static paths into an O(1) method-indexed map checked prior to normalization, while dynamic segments and regex constraints traverse a compact Radix tree.

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

## Route groups, autoHead & prototype-key protection

- Nested app.group("/api/v1", (api) => ...) composes prefixes, scoped middleware, and route metadata cleanly.
- Route params use null-prototype objects and reject __proto__, constructor, and prototype parameter keys.
- Automatic HEAD handling (autoHead) and RFC 405 Allow header generation are enabled by default.
- Duplicate or conflicting route definitions throw RouteConflictError at registration time.
