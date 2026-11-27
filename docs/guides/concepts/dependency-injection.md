# Dependency Injection

> Typed DI tokens, singleton/transient/request scopes, captive-dependency detection, cycle errors, and LIFO async disposal.

- **Section**: Core Concepts
- **Packages**: @forge-fr/core, @forge-fr/testing
- **Version**: v1.0.0-rc.1
- **Updated**: 2026-11-26
- **HTML URL**: https://github.com/forge-fr/forgejs/docs/concepts/dependency-injection
- **Markdown URL**: https://github.com/forge-fr/forgejs/docs/concepts/dependency-injection.md
- **Source**: https://github.com/forge-fr/forgejs/blob/main/docs/architecture.md

## Tokens, providers, and scopes

- singleton — Instantiated once per root container and disposed in reverse LIFO order on container.dispose().
- transient — Created fresh on every resolve() call.
- request — Created once per child scope (container.createScope()) and disposed automatically at the end of the HTTP request.

**File: `src/di.ts`**

```ts
import assert from 'node:assert/strict';
import { createContainer, createToken } from '@forge-fr/core';

const ConfigToken = createToken<{ appName: string }>('app.config');
const RequestIdToken = createToken<string>('request.id');

let seq = 0;
const container = createContainer();

container.register({
  token: ConfigToken,
  scope: 'singleton',
  useValue: { appName: 'forge-orders' },
});

container.register({
  token: RequestIdToken,
  scope: 'request',
  useFactory: () => `req-${++seq}`,
});

const scope = container.createScope();
assert.equal(scope.resolve(RequestIdToken), 'req-1');
assert.equal(scope.resolve(RequestIdToken), 'req-1');
assert.equal(scope.resolve(ConfigToken).appName, 'forge-orders');
await scope.dispose();
await container.dispose();
```

## Captive-dependency & cycle guards

| Error Class | Trigger Condition |
| --- | --- |
| ScopeViolationError | A singleton provider injects a request-scoped provider (captive dependency) |
| CircularDependencyError | Provider A depends on B which depends back on A (includes full token cycle path) |
| ProviderNotFoundError | Resolving a token that was never registered or exported |
| ContainerDisposedError | Calling register() or resolve() after dispose() completed |
