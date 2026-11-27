import { defineModule } from '@forge-fr/core';
import { QueueTokens } from '@forge-fr/queue';
import { authModule } from '../auth/auth.module.ts';
import { AuthServiceToken } from '../auth/auth.service.ts';
import { PlaygroundStoreToken } from '../store.ts';
import { PlaygroundTokens } from '../types.ts';
import { WebhooksServiceToken, createWebhooksService } from './webhooks.service.ts';

export const webhooksModule = defineModule({
  name: 'webhooks',
  imports: [authModule],
  providers: [
    {
      token: WebhooksServiceToken,
      scope: 'singleton',
      useFactory: (resolver) =>
        createWebhooksService({
          store: resolver.resolve(PlaygroundStoreToken),
          queue: resolver.resolve(QueueTokens.Queue),
          auth: resolver.resolve(AuthServiceToken),
          replayHealthyOverrides: resolver.resolve(PlaygroundTokens.ReplayHealthyOverrides),
        }),
    },
  ],
  exports: [WebhooksServiceToken],
});
