import { defineModule } from '@forge-fr/core';
import { authModule } from '../auth/auth.module.ts';
import { AuthServiceToken } from '../auth/auth.service.ts';
import { PlaygroundStoreToken } from '../store.ts';
import { PlaygroundTokens } from '../types.ts';
import { ObservabilityServiceToken } from './observability.ts';
import { SystemServiceToken, createSystemService } from './system.service.ts';

export const systemModule = defineModule({
  name: 'system',
  imports: [authModule],
  providers: [
    {
      token: SystemServiceToken,
      scope: 'singleton',
      useFactory: (resolver) =>
        createSystemService({
          store: resolver.resolve(PlaygroundStoreToken),
          auth: resolver.resolve(AuthServiceToken),
          logSink: resolver.resolve(PlaygroundTokens.LogSink),
          observability: resolver.resolve(ObservabilityServiceToken),
          onReset: resolver.resolve(PlaygroundTokens.ResetSandbox),
        }),
    },
  ],
  exports: [SystemServiceToken],
});
