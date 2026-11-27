import { defineModule } from '@forge-fr/core';
import { CacheTokens } from '@forge-fr/cache';
import { StorageTokens } from '@forge-fr/storage';
import { authModule } from '../auth/auth.module.ts';
import { AuthServiceToken } from '../auth/auth.service.ts';
import { PlaygroundStoreToken } from '../store.ts';
import { webhooksModule } from '../webhooks/webhooks.module.ts';
import { WebhooksServiceToken } from '../webhooks/webhooks.service.ts';
import { TasksServiceToken, createTasksService } from './tasks.service.ts';

export const tasksModule = defineModule({
  name: 'tasks',
  imports: [authModule, webhooksModule],
  providers: [
    {
      token: TasksServiceToken,
      scope: 'singleton',
      useFactory: (resolver) =>
        createTasksService({
          store: resolver.resolve(PlaygroundStoreToken),
          cache: resolver.resolve(CacheTokens.Adapter),
          storage: resolver.resolve(StorageTokens.Adapter),
          auth: resolver.resolve(AuthServiceToken),
          webhooks: resolver.resolve(WebhooksServiceToken),
        }),
    },
  ],
  exports: [TasksServiceToken],
});
