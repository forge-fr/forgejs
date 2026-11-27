import { defineModule } from '@forge-fr/core';
import { authModule } from '../auth/auth.module.ts';
import { AuthServiceToken } from '../auth/auth.service.ts';
import { PlaygroundStoreToken } from '../store.ts';
import { RealtimeServiceToken, createRealtimeService } from './realtime.service.ts';

export const realtimeModule = defineModule({
  name: 'realtime',
  imports: [authModule],
  providers: [
    {
      token: RealtimeServiceToken,
      scope: 'singleton',
      useFactory: (resolver) =>
        createRealtimeService({
          auth: resolver.resolve(AuthServiceToken),
          store: resolver.resolve(PlaygroundStoreToken),
        }),
    },
  ],
  exports: [RealtimeServiceToken],
});
