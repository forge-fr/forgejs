# Dependency Injection

> Wire services cleanly with typed tokens, singleton/transient/request lifetimes, cycle detection, and automatic cleanup.

- **Section**: Core Concepts
- **Packages**: @forge-fr/core, @forge-fr/testing
- **Version**: v1.0.0
- **Updated**: 2026-11-27
- **HTML URL**: https://github.com/forge-fr/forgejs/docs/concepts/dependency-injection
- **Markdown URL**: https://github.com/forge-fr/forgejs/docs/concepts/dependency-injection.md
- **Source**: https://github.com/forge-fr/forgejs/blob/main/docs/architecture.md

## Typed tokens and service lifetimes

- singleton — Created once for the whole app and cleaned up automatically when the app stops.
- transient — Created brand new every time resolve() is called.
- request — Created once per HTTP request (via container.createScope()) and cleaned up as soon as that request finishes.

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

## Built-in safety checks for wiring mistakes

| Error Class | When ForgeJS Throws It |
| --- | --- |
| ScopeViolationError | A long-lived singleton tries to depend on a per-request service |
| CircularDependencyError | Service A depends on B and B depends back on A (prints the exact loop) |
| ProviderNotFoundError | You ask for a token that was never registered or exported |
| ContainerDisposedError | You try to register or resolve a service after the app shut down |
