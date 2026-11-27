import {
  createToken,
  definePlugin,
  type ForgePlugin,
  type PluginContext,
} from '@forge-fr/core';
import {
  createAuthorizer,
  type Authorizer,
  type AuthorizerOptions,
} from './authorizer.js';
import type { RbacRegistry } from './permissions.js';

export const AuthorizationTokens = Object.freeze({
  Authorizer: createToken<Authorizer>('AuthorizationAuthorizer'),
  RbacRegistry: createToken<RbacRegistry>('AuthorizationRbacRegistry'),
});

export type AuthorizationPluginConfig = AuthorizerOptions;

export interface AuthorizationPluginOptions {
  readonly name?: string;
  readonly version?: string;
  readonly forgeVersion?: string;
}

export function createAuthorizationPlugin(
  options: AuthorizationPluginOptions = {},
): ForgePlugin<AuthorizationPluginConfig, AuthorizationPluginConfig> {
  return definePlugin<AuthorizationPluginConfig, AuthorizationPluginConfig>({
    name: options.name ?? '@forge-fr/authorization',
    version: options.version ?? '1.0.0-rc.1',
    forgeVersion: options.forgeVersion ?? '^0.1.0 || ^1.0.0-rc.1',
    capabilities: ['di:register'],

    register(
      ctx: PluginContext<AuthorizationPluginConfig>,
      rawConfig: AuthorizationPluginConfig | undefined,
    ): void {
      const authorizer = createAuthorizer(rawConfig ?? {});

      ctx.registerProvider(
        { token: AuthorizationTokens.Authorizer, useValue: authorizer },
        { export: true },
      );

      ctx.registerProvider(
        { token: AuthorizationTokens.RbacRegistry, useValue: authorizer.rbac },
        { export: true },
      );
    },
  });
}
