# Events & Hooks

> Emit typed domain events with flexible error handling and run ordered hook pipelines using @forge-fr/core.

- **Section**: Advanced Features
- **Packages**: @forge-fr/core
- **Version**: v1.0.0
- **Updated**: 2026-11-27
- **HTML URL**: https://github.com/forge-fr/forgejs/docs/advanced/events-and-hooks
- **Markdown URL**: https://github.com/forge-fr/forgejs/docs/advanced/events-and-hooks.md
- **Source**: https://github.com/forge-fr/forgejs/blob/main/docs/architecture.md

## Choose how listener errors behave

| Error Strategy | What Happens If a Listener Throws |
| --- | --- |
| fail-fast (default) | Stops right away and throws the first listener error |
| collect | Runs every listener and throws an AggregateError with all failures |
| isolate | Runs every listener and passes errors to onError without failing emit() |

**File: `src/events.ts`**

```ts
import { createEventDispatcher, createHookRegistry } from '@forge-fr/core';

type AppEvents = { 'user.created': { id: string; email: string } };
const events = createEventDispatcher<AppEvents>({ errorStrategy: 'collect' });

events.on('user.created', ({ id }) => {
  console.info('Audit user signup:', id);
});
await events.emit('user.created', { id: 'u_101', email: 'ada@example.com' });

const hooks = createHookRegistry<{ beforeSave: { entityId: string } }>();
hooks.add('beforeSave', (payload) => console.info('Saving', payload.entityId), { priority: 10 });
await hooks.run('beforeSave', { entityId: 'ord_55' });
```
