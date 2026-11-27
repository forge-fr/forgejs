import { defineModule } from '@forge-fr/core';
import { StorageTokens } from '@forge-fr/storage';
import { authModule } from '../auth/auth.module.ts';
import { AuthServiceToken } from '../auth/auth.service.ts';
import { PlaygroundStoreToken } from '../store.ts';
import { webhooksModule } from '../webhooks/webhooks.module.ts';
import { WebhooksServiceToken } from '../webhooks/webhooks.service.ts';
import { AttachmentsServiceToken, createAttachmentsService } from './attachments.service.ts';

export const attachmentsModule = defineModule({
  name: 'attachments',
  imports: [authModule, webhooksModule],
  providers: [
    {
      token: AttachmentsServiceToken,
      scope: 'singleton',
      useFactory: (resolver) =>
        createAttachmentsService({
          store: resolver.resolve(PlaygroundStoreToken),
          storage: resolver.resolve(StorageTokens.Adapter),
          auth: resolver.resolve(AuthServiceToken),
          webhooks: resolver.resolve(WebhooksServiceToken),
        }),
    },
  ],
  exports: [AttachmentsServiceToken],
});
