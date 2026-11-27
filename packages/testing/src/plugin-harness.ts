import {
  PluginEncapsulationError,
  createKernel,
  createNoopLogger,
  type AnyProviderDefinition,
  type ApplicationKernel,
  type ConfigManager,
  type ConfigManagerOptions,
  type ForgeLogger,
  type ForgePlugin,
  type ForgePluginDefinition,
  type HealthReport,
  type InjectionToken,
  type KernelPluginInput,
  type ResolvedPluginEntry,
} from '@forge-fr/core';

export interface PluginTestHarnessOptions<TConfig = unknown, TConfigInput = TConfig> {
  readonly plugin: ForgePlugin<TConfig, TConfigInput> | ForgePluginDefinition<TConfig, TConfigInput>;
  readonly config?: TConfigInput;
  readonly dependencies?: readonly KernelPluginInput[];
  readonly forgeVersion?: string;
  readonly kernelConfig?: ConfigManager | ConfigManagerOptions<Record<string, unknown>>;
  readonly logger?: ForgeLogger;
  readonly providers?: readonly AnyProviderDefinition[];
}

export interface PluginTestHarness {
  readonly pluginName: string;
  readonly kernel: ApplicationKernel;
  configure(): Promise<void>;
  register(): Promise<void>;
  initialize(): Promise<void>;
  start(): Promise<void>;
  shutdown(): Promise<void>;
  dispose(): Promise<void>;
  resolveExport<T>(token: InjectionToken<T>): T;
  health(): Promise<HealthReport>;
  getResolvedPlugins(): readonly ResolvedPluginEntry[];
}

export function createPluginTestHarness<TConfig = unknown, TConfigInput = TConfig>(
  options: PluginTestHarnessOptions<TConfig, TConfigInput>,
): PluginTestHarness {
  const kernel = createKernel({
    ...(options.forgeVersion !== undefined ? { forgeVersion: options.forgeVersion } : {}),
    ...(options.kernelConfig !== undefined ? { config: options.kernelConfig } : {}),
    logger: options.logger ?? createNoopLogger(),
    ...(options.providers !== undefined ? { providers: options.providers } : {}),
    ...(options.dependencies !== undefined ? { plugins: options.dependencies } : {}),
  });

  kernel.plugin(options.plugin, options.config);
  const pluginName = options.plugin.name;

  return {
    pluginName,
    kernel,
    configure: () => kernel.configure(),
    register: () => kernel.register(),
    initialize: () => kernel.initialize(),
    start: () => kernel.start(),
    shutdown: () => kernel.shutdown(),
    dispose: () => kernel.dispose(),
    resolveExport<T>(token: InjectionToken<T>): T {
      const exports = kernel.getPluginExports(pluginName);
      if (!exports.has(token.id)) {
        throw new PluginEncapsulationError(
          pluginName,
          token,
          `Token "${token.description}" is not exported by plugin "${pluginName}"`,
        );
      }
      return kernel.container.resolve(token);
    },
    health: () => kernel.health.runAll(),
    getResolvedPlugins: () => kernel.plugins.resolve(),
  };
}
