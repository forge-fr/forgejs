import {
  createToken,
  definePlugin,
  type ForgePlugin,
  type InjectionToken,
} from '@forge-fr/core';
import type { StandardSchemaV1 } from '@standard-schema/spec';
import {
  loadConfig,
  type ConfigOutput,
  type LoadConfigOptions,
} from './define-config.js';
import { redactConfig } from './redact.js';

export const ConfigTokens = Object.freeze({
  Config: createToken<Readonly<Record<string, unknown>>>('@forge-fr/config:Config'),
});

/** Creates a strongly typed DI token for resolving a validated application config object. */
export function createConfigToken<TConfig>(
  name = '@forge-fr/config:AppConfig',
): InjectionToken<Readonly<TConfig>> {
  return createToken<Readonly<TConfig>>(name);
}

export interface ConfigPluginOptions<TSchema extends StandardSchemaV1>
  extends LoadConfigOptions<TSchema> {
  /** Optional typed DI token to register alongside `ConfigTokens.Config`. */
  readonly token?: InjectionToken<ConfigOutput<TSchema>>;
  /** Pre-validated config object (skips re-parsing when supplied). */
  readonly value?: ConfigOutput<TSchema>;
  /** Register a secret-safe `config:validated` health check. Default: `true`. */
  readonly registerHealthCheck?: boolean;
}

/**
 * ForgeJS DI plugin that validates configuration on startup (`configure` phase) and
 * exports the immutable typed configuration object to the kernel container.
 */
export function createConfigPlugin<TSchema extends StandardSchemaV1>(
  options: ConfigPluginOptions<TSchema>,
): ForgePlugin<undefined, undefined> {
  let resolvedConfig: ConfigOutput<TSchema> | undefined = options.value;

  return definePlugin({
    name: '@forge-fr/config',
    version: '1.0.0',
    forgeVersion: '^0.1.0 || ^1.0.0-rc.1 || ^1.0.0',
    capabilities: ['di:register', 'health:register'],
    async register(ctx) {
      if (resolvedConfig === undefined) {
        resolvedConfig = await loadConfig(options);
      }

      ctx.registerProvider(
        {
          token: ConfigTokens.Config,
          useValue: resolvedConfig as Readonly<Record<string, unknown>>,
        },
        { export: true },
      );

      if (options.token !== undefined) {
        ctx.registerProvider(
          { token: options.token, useValue: resolvedConfig },
          { export: true },
        );
      }

      if (options.registerHealthCheck !== false) {
        const snapshot =
          typeof resolvedConfig === 'object' && resolvedConfig !== null
            ? redactConfig(resolvedConfig as Record<string, unknown>, {
                ...(options.secrets !== undefined ? { secrets: options.secrets } : {}),
              })
            : {};
        const keyCount = Object.keys(snapshot).length;
        ctx.registerHealthCheck('config:validated', () => ({
          status: 'ok',
          details: { keyCount },
        }));
      }
    },
  });
}
