import {
  definePlugin,
  type ForgePlugin,
  type HealthCheckResult,
  type InjectionToken,
  type PluginContext,
  type StandardSchemaLike,
} from '@forge-fr/core';
import { DefaultDatabaseTokens, type DatabaseAdapter } from './types.js';

export interface DatabasePluginOptions<
  TClient = unknown,
  TTxClient = TClient,
  TConfig = unknown,
  TConfigInput = TConfig,
> {
  readonly name?: string;
  readonly version?: string;
  readonly forgeVersion?: string;
  readonly adapterToken?: InjectionToken<DatabaseAdapter<TClient, TTxClient>>;
  readonly clientToken?: InjectionToken<TClient>;
  readonly healthCheckName?: string;
  readonly configSchema?: StandardSchemaLike<TConfigInput, TConfig>;
  readonly createAdapter: (config: TConfig) => DatabaseAdapter<TClient, TTxClient>;
}

export function createDatabasePlugin<
  TClient = unknown,
  TTxClient = TClient,
  TConfig = unknown,
  TConfigInput = TConfig,
>(
  options: DatabasePluginOptions<TClient, TTxClient, TConfig, TConfigInput>,
): ForgePlugin<TConfig, TConfigInput> {
  const pluginName = options.name ?? '@forge-fr/database';
  const pluginVersion = options.version ?? '1.0.0-rc.1';
  const forgeVersion = options.forgeVersion ?? '^0.1.0 || ^1.0.0-rc.1';
  const adapterToken = (options.adapterToken ??
    DefaultDatabaseTokens.adapter) as InjectionToken<DatabaseAdapter<TClient, TTxClient>>;
  const clientToken = (options.clientToken ??
    DefaultDatabaseTokens.client) as InjectionToken<TClient>;
  const healthCheckName = options.healthCheckName ?? pluginName;

  const adaptersByContext = new WeakMap<
    PluginContext<TConfig>,
    DatabaseAdapter<TClient, TTxClient>
  >();

  return definePlugin<TConfig, TConfigInput>({
    name: pluginName,
    version: pluginVersion,
    forgeVersion,
    capabilities: ['di:register', 'health:register'],
    ...(options.configSchema !== undefined ? { configSchema: options.configSchema } : {}),

    register(ctx: PluginContext<TConfig>, config: TConfig): void {
      const adapter = options.createAdapter(config);
      adaptersByContext.set(ctx, adapter);

      ctx.registerProvider(
        {
          token: adapterToken,
          useValue: adapter,
        },
        { export: true },
      );

      // Register client lazily via singleton factory so resolving after initialize() returns the connected native client
      ctx.registerProvider(
        {
          token: clientToken,
          useFactory: () => adapter.client,
          scope: 'singleton',
        },
        { export: true },
      );

      ctx.registerHealthCheck(healthCheckName, async (): Promise<HealthCheckResult> => {
        if (adapter.state !== 'connected') {
          return {
            status: 'unhealthy',
            message: `Database adapter "${adapter.name}" is in "${adapter.state}" state`,
            details: {
              driver: adapter.driver,
              state: adapter.state,
            },
          };
        }

        try {
          const result = await adapter.ping();
          return {
            status: 'ok',
            details: {
              driver: adapter.driver,
              latencyMs: result.latencyMs,
            },
          };
        } catch (err: unknown) {
          return {
            status: 'unhealthy',
            message: err instanceof Error ? err.message : 'Database ping failed',
            details: {
              driver: adapter.driver,
              state: adapter.state,
            },
          };
        }
      });
    },

    async initialize(ctx: PluginContext<TConfig>): Promise<void> {
      const adapter = adaptersByContext.get(ctx);
      if (adapter !== undefined) {
        await adapter.connect();
      }
    },

    async onShutdown(ctx: PluginContext<TConfig>): Promise<void> {
      const adapter = adaptersByContext.get(ctx);
      if (adapter !== undefined) {
        await adapter.disconnect();
      }
    },
  });
}
