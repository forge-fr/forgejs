import { defineModule } from '@forge-fr/core';
import { authModule } from '../auth/auth.module.ts';
import { SecurityServiceToken, createSecurityService } from './security.service.ts';

export const securityModule = defineModule({
  name: 'security',
  imports: [authModule],
  providers: [
    {
      token: SecurityServiceToken,
      scope: 'singleton',
      useFactory: () => createSecurityService(),
    },
  ],
  exports: [SecurityServiceToken],
});
