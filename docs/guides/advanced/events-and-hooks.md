# Events & Hooks

> Typed EventDispatcher (fail-fast, collect, isolate error strategies) and priority HookRegistry pipelines in @forge-fr/core.

- **Section**: Advanced Features
- **Packages**: @forge-fr/core
- **Version**: v1.0.0-rc.2
- **Updated**: 2026-11-26
- **HTML URL**: https://github.com/forge-fr/forgejs/docs/advanced/events-and-hooks
- **Markdown URL**: https://github.com/forge-fr/forgejs/docs/advanced/events-and-hooks.md
- **Source**: https://github.com/forge-fr/forgejs/blob/main/docs/architecture.md

## EventDispatcher error strategies

| Strategy | Behavior when a listener throws |
| --- | --- |
| fail-fast (default) | Stops dispatching immediately and rejects with the first listener error |
| collect | Runs all listeners and throws AggregateError if one or more fail |
| isolate | Runs all listeners and routes errors to onError without failing emit() |

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
