# Application Lifecycle

> Predictable 7-stage startup and shutdown lifecycle in ApplicationKernel with automatic rollback on boot errors.

- **Section**: Core Concepts
- **Packages**: @forge-fr/core
- **Version**: v1.0.0
- **Updated**: 2026-11-27
- **HTML URL**: https://github.com/forge-fr/forgejs/docs/concepts/lifecycle
- **Markdown URL**: https://github.com/forge-fr/forgejs/docs/concepts/lifecycle.md
- **Source**: https://github.com/forge-fr/forgejs/blob/main/docs/architecture.md

## Seven predictable stages from boot to shutdown

| Stage | State Transition | What Happens |
| --- | --- | --- |
| configure | created → configuring → configured | Validates app and plugin settings using your config schemas |
| register | configured → registering → registered | Registers module and plugin services into the DI container |
| initialize | registered → initializing → initialized | Runs module and plugin setup hooks in dependency order |
| start | initialized → starting → started | Opens database pools, starts queue workers, and prepares servers |
| ready | started → ready | App is live, accepting requests, and passing /health/ready |
| shutdown | ready → shutting_down → shutdown | Finishes active requests and stops plugins in reverse order |
| dispose | shutdown → disposing → disposed | Runs cleanup callbacks (last-in, first-out) and frees resources |

## Watching lifecycle events & automatic boot rollback

Listen to kernel.events.on("lifecycle:stage") or register hooks with kernel.hooks.add(). If a plugin fails while starting, ApplicationKernel automatically cleans up everything that already started in reverse order before throwing the error.

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
