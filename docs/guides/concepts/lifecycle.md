# Application Lifecycle

> Deterministic 7-stage ApplicationKernel lifecycle with boot-failure rollback, lifecycle events, and reverse-order graceful shutdown.

- **Section**: Core Concepts
- **Packages**: @forge-fr/core
- **Version**: v1.0.0-rc.2
- **Updated**: 2026-11-26
- **HTML URL**: https://github.com/forge-fr/forgejs/docs/concepts/lifecycle
- **Markdown URL**: https://github.com/forge-fr/forgejs/docs/concepts/lifecycle.md
- **Source**: https://github.com/forge-fr/forgejs/blob/main/docs/architecture.md

## Seven deterministic stages

| Stage | Kernel State Transition | Responsibility |
| --- | --- | --- |
| configure | created → configuring → configured | Validate kernel and plugin config schemas via Standard Schema v1 |
| register | configured → registering → registered | Register module and plugin providers into the typed DI container |
| initialize | registered → initializing → initialized | Run module/plugin initialization hooks in topological dependency order |
| start | initialized → starting → started | Open database pools, queue workers, and transport listeners |
| ready | started → ready | Application accepts live traffic and serves /health/ready |
| shutdown | ready → shutting_down → shutdown | Drain in-flight connections and stop plugins in reverse topological order |
| dispose | shutdown → disposing → disposed | Invoke LIFO async provider disposers and release container resources |

## Observing lifecycle transitions & boot-failure rollback

Subscribe to kernel.events.on("lifecycle:stage") or register stage hooks via kernel.hooks.add(). If any plugin fails during initialize or start, ApplicationKernel automatically triggers reverse-order rollback cleanup before rethrowing.

**File: `src/kernel.ts`**

```ts
import { createKernel } from '@forge-fr/core';

const kernel = createKernel();

kernel.events.on('lifecycle:stage', ({ from, to }) => {
  console.info('Kernel transition:', from, '->', to);
});

kernel.hooks.add('ready', async () => {
  console.info('All modules and plugins are ready');
});

await kernel.start();
await kernel.shutdown();
```
