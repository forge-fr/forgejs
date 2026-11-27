import { defineModule } from '@forge-fr/core';
import { PlaygroundStoreToken } from '../store.ts';
import { PlaygroundTokens } from '../types.ts';
import { AuthServiceToken, createAuthService } from './auth.service.ts';

export const authModule = defineModule({
  name: 'auth',
  providers: [
    {
      token: AuthServiceToken,
      scope: 'singleton',
      useFactory: (resolver) =>
        createAuthService(
          resolver.resolve(PlaygroundStoreToken),
          resolver.resolveOptional(PlaygroundTokens.AuthConfig),
        ),
    },
  ],
  exports: [AuthServiceToken],
});
