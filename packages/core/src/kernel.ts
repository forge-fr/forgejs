import {
  createConfigManager,
  type ConfigManager,
  type ConfigManagerOptions,
} from './config.js';
import {
  createContainer,
  createToken,
  type ClassProvider,
  type Container,
  type DependencyResolver,
  type FactoryProvider,
  type InjectionToken,
  type RegisterOptions,
  type ValueProvider,
} from './di.js';
import { ForgeError } from './errors.js';
import { createEventDispatcher, type EventDispatcher } from './events.js';
import { createHealthRegistry, type HealthRegistry } from './health.js';
import { createHookRegistry, type HookRegistry } from './hooks.js';
import { createConsoleLogger, type ForgeLogger } from './logger.js';
import {
  createModuleRegistry,
  type AnyProviderDefinition,
  type ForgeModule,
  type ModuleLifecycleContext,
  type ModuleRegistry,
} from './modules.js';
import {
  FORGE_CORE_VERSION,
  PluginEncapsulationError,
  createPluginContext,
  createPluginRegistry,
  validatePluginConfig,
  type ForgePlugin,
  type ForgePluginDefinition,
  type PluginContext,
  type PluginProviderRegisterOptions,
  type PluginRegistry,
  type ResolvedPluginEntry,
} from './plugins.js';

export type LifecycleStage =
  | 'configure'
  | 'register'
  | 'initialize'
  | 'start'
  | 'ready'
  | 'shutdown'
  | 'dispose';

export type KernelState =
  | 'created'
  | 'configuring'
  | 'configured'
  | 'registering'
  | 'registered'
  | 'initializing'
  | 'initialized'
  | 'starting'
  | 'started'
  | 'ready'
  | 'shutting_down'
  | 'shutdown'
  | 'disposing'
  | 'disposed'
  | 'failed';

export interface LifecycleStageEvent {
  readonly from: KernelState;
  readonly to: KernelState;
  readonly timestamp: string;
}

export interface LifecycleErrorEvent {
  readonly stage: LifecycleStage;
  readonly error: unknown;
}

export interface KernelEventMap extends Record<string, unknown> {
  'lifecycle:stage': LifecycleStageEvent;
  'lifecycle:error': LifecycleErrorEvent;
}

export interface KernelHookContext {
  readonly kernel: ApplicationKernel;
  readonly stage: LifecycleStage;
}

export interface KernelHooks extends Record<string, unknown> {
  configure: KernelHookContext;
  register: KernelHookContext;
  initialize: KernelHookContext;
  start: KernelHookContext;
  ready: KernelHookContext;
  shutdown: KernelHookContext;
  dispose: KernelHookContext;
}

export class LifecycleError extends ForgeError {
  public constructor(message: string, details?: Record<string, unknown>) {
    super(message, {
      code: 'LIFECYCLE_ERROR',
      statusCode: 500,
      expose: false,
      ...(details !== undefined ? { details } : {}),
    });
  }
}

export const KernelConfigToken = createToken<ConfigManager>('KernelConfig');
export const KernelLoggerToken = createToken<ForgeLogger>('KernelLogger');
export const KernelEventsToken = createToken<EventDispatcher<KernelEventMap>>('KernelEvents');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyForgePlugin = ForgePlugin<any, any> | ForgePluginDefinition<any, any>;

export type KernelPluginInput = AnyForgePlugin | readonly [AnyForgePlugin, unknown];

export interface KernelOptions<
  TConfig extends Record<string, unknown> = Record<string, unknown>,
> {
  readonly forgeVersion?: string;
  readonly config?: ConfigManager<TConfig> | ConfigManagerOptions<TConfig>;
  readonly logger?: ForgeLogger;
  readonly modules?: readonly ForgeModule[];
  readonly providers?: readonly AnyProviderDefinition[];
  readonly plugins?: readonly KernelPluginInput[];
}

export interface ApplicationKernel {
  readonly state: KernelState;
  readonly forgeVersion: string;
  readonly config: ConfigManager;
  readonly logger: ForgeLogger;
  readonly events: EventDispatcher<KernelEventMap>;
  readonly hooks: HookRegistry<KernelHooks>;
  readonly health: HealthRegistry;
  readonly container: Container;
  readonly modules: ModuleRegistry;
  readonly plugins: PluginRegistry;
  registerModule(mod: ForgeModule): this;
  registerProvider(provider: AnyProviderDefinition, options?: RegisterOptions): this;
  plugin<TConfig = unknown, TConfigInput = TConfig>(
    plugin: ForgePlugin<TConfig, TConfigInput> | ForgePluginDefinition<TConfig, TConfigInput>,
    config?: TConfigInput,
  ): this;
  removePlugin(name: string): boolean;
  getPluginExports(pluginName: string): ReadonlySet<symbol>;
  createRequestScope(): Container;
  configure(): Promise<void>;
  register(): Promise<void>;
  initialize(): Promise<void>;
  start(): Promise<void>;
  shutdown(): Promise<void>;
  dispose(): Promise<void>;
}

function isConfigManager(value: unknown): value is ConfigManager {
  return (
    typeof value === 'object' &&
    value !== null &&
    'get' in value &&
    'getOrThrow' in value &&
    'toSafeObject' in value
  );
}

function isValueProvider(provider: AnyProviderDefinition): provider is ValueProvider<unknown> {
  return 'useValue' in provider;
}

function isFactoryProvider(provider: AnyProviderDefinition): provider is FactoryProvider<unknown> {
  return 'useFactory' in provider;
}

function isClassProvider(provider: AnyProviderDefinition): provider is ClassProvider<unknown> {
  return 'useClass' in provider;
}

class ForgeKernel implements ApplicationKernel {
  public readonly forgeVersion: string;
  public readonly config: ConfigManager;
  public readonly logger: ForgeLogger;
  public readonly events: EventDispatcher<KernelEventMap>;
  public readonly hooks: HookRegistry<KernelHooks>;
  public readonly health: HealthRegistry;
  public readonly container: Container;
  public readonly modules: ModuleRegistry;
  public readonly plugins: PluginRegistry;

  private currentState: KernelState = 'created';
  private readonly initializedModules: ForgeModule[] = [];
  private readonly globalTokenIds = new Set<symbol>();
  private readonly validatedPluginConfigs = new Map<string, unknown>();
  private readonly pluginContexts = new Map<string, PluginContext>();
  private readonly pluginOwnTokens = new Map<string, Set<symbol>>();
  private readonly pluginExportedTokens = new Map<string, Set<symbol>>();
  private readonly pluginCleanups = new Map<string, (() => void)[]>();
  private readonly registeredPlugins: ResolvedPluginEntry[] = [];
  private readonly initializedPlugins: ResolvedPluginEntry[] = [];
  private pluginHookSeq = 0;

  public constructor(options: KernelOptions = {}) {
    this.forgeVersion = options.forgeVersion ?? FORGE_CORE_VERSION;
    this.config =
      options.config !== undefined
        ? isConfigManager(options.config)
          ? options.config
          : createConfigManager(options.config)
        : createConfigManager();

    this.logger = options.logger ?? createConsoleLogger();
    this.events = createEventDispatcher<KernelEventMap>({ errorStrategy: 'isolate' });
    this.hooks = createHookRegistry<KernelHooks>();
    this.health = createHealthRegistry();
    this.container = createContainer();

    // Register core kernel tokens as globally visible to all modules & plugins
    this.container.register({ token: KernelConfigToken, useValue: this.config });
    this.container.register({ token: KernelLoggerToken, useValue: this.logger });
    this.container.register({ token: KernelEventsToken, useValue: this.events });
    this.globalTokenIds.add(KernelConfigToken.id);
    this.globalTokenIds.add(KernelLoggerToken.id);
    this.globalTokenIds.add(KernelEventsToken.id);

    this.modules = createModuleRegistry(this.container, {
      globalTokens: [KernelConfigToken, KernelLoggerToken, KernelEventsToken],
    });
    this.plugins = createPluginRegistry({ forgeVersion: this.forgeVersion });

    for (const provider of options.providers ?? []) {
      this.registerProvider(provider);
    }

    for (const mod of options.modules ?? []) {
      this.registerModule(mod);
    }

    for (const pluginInput of options.plugins ?? []) {
      if (Array.isArray(pluginInput)) {
        const [pluginDef, pluginConfig] = pluginInput as readonly [AnyForgePlugin, unknown];
        this.plugin(pluginDef, pluginConfig);
      } else {
        this.plugin(pluginInput as AnyForgePlugin);
      }
    }
  }

  public get state(): KernelState {
    return this.currentState;
  }

  private async transition(next: KernelState): Promise<void> {
    const prev = this.currentState;
    this.currentState = next;
    await this.events.emit('lifecycle:stage', {
      from: prev,
      to: next,
      timestamp: new Date().toISOString(),
    });
  }

  private assertNotTerminal(action: string): void {
    if (this.currentState === 'disposed' || this.currentState === 'disposing') {
      throw new LifecycleError(`Cannot ${action} kernel after disposal`, {
        state: this.currentState,
      });
    }
    if (this.currentState === 'failed') {
      throw new LifecycleError(`Cannot ${action} kernel after a failed boot`, {
        state: this.currentState,
      });
    }
  }

  public registerModule(mod: ForgeModule): this {
    if (
      this.currentState !== 'created' &&
      this.currentState !== 'configured' &&
      this.currentState !== 'registering'
    ) {
      throw new LifecycleError(
        `Cannot register module "${mod.name}" while kernel is in state "${this.currentState}"`,
        { state: this.currentState, moduleName: mod.name },
      );
    }
    this.modules.register(mod);
    return this;
  }

  public registerProvider(
    provider: AnyProviderDefinition,
    options?: RegisterOptions,
  ): this {
    if (
      this.currentState !== 'created' &&
      this.currentState !== 'configured' &&
      this.currentState !== 'registering'
    ) {
      throw new LifecycleError(
        `Cannot register provider "${provider.token.description}" while kernel is in state "${this.currentState}"`,
        { state: this.currentState },
      );
    }
    this.container.register(provider, options);
    this.globalTokenIds.add(provider.token.id);
    this.modules.addGlobalToken(provider.token);
    return this;
  }

  private assertPreStartPluginMutation(action: string, pluginName: string): void {
    if (
      this.currentState !== 'created' &&
      this.currentState !== 'configured' &&
      this.currentState !== 'registered' &&
      this.currentState !== 'initialized'
    ) {
      throw new LifecycleError(
        `Cannot ${action} plugin "${pluginName}" while kernel is in state "${this.currentState}"`,
        { state: this.currentState, pluginName },
      );
    }
  }

  public plugin<TConfig = unknown, TConfigInput = TConfig>(
    plugin: ForgePlugin<TConfig, TConfigInput> | ForgePluginDefinition<TConfig, TConfigInput>,
    config?: TConfigInput,
  ): this {
    this.assertPreStartPluginMutation('register', plugin.name);
    this.plugins.register(plugin, config);
    return this;
  }

  public removePlugin(name: string): boolean {
    this.assertPreStartPluginMutation('remove', name);
    const removed = this.plugins.removePlugin(name);
    if (removed) {
      this.validatedPluginConfigs.delete(name);
      this.pluginContexts.delete(name);
      this.runPluginCleanups(name);
    }
    return removed;
  }

  public getPluginExports(pluginName: string): ReadonlySet<symbol> {
    return new Set(this.pluginExportedTokens.get(pluginName) ?? []);
  }

  public createRequestScope(): Container {
    if (
      this.currentState !== 'initialized' &&
      this.currentState !== 'starting' &&
      this.currentState !== 'started' &&
      this.currentState !== 'ready'
    ) {
      throw new LifecycleError(
        `Cannot create request scope while kernel is in state "${this.currentState}"`,
        { state: this.currentState },
      );
    }
    return this.container.createScope();
  }

  private isTokenVisibleToPlugin(entry: ResolvedPluginEntry, tokenId: symbol): boolean {
    if (this.globalTokenIds.has(tokenId)) {
      return true;
    }
    if (this.pluginOwnTokens.get(entry.plugin.name)?.has(tokenId) === true) {
      return true;
    }
    for (const depName of entry.resolvedDependencies) {
      if (this.pluginExportedTokens.get(depName)?.has(tokenId) === true) {
        return true;
      }
    }
    for (const optDepName of entry.resolvedOptionalDependencies) {
      if (this.pluginExportedTokens.get(optDepName)?.has(tokenId) === true) {
        return true;
      }
    }
    return false;
  }

  private createPluginScopedResolver(
    entry: ResolvedPluginEntry,
    base: DependencyResolver,
  ): DependencyResolver {
    return {
      resolve: <T>(token: InjectionToken<T>): T => {
        if (!this.isTokenVisibleToPlugin(entry, token.id)) {
          throw new PluginEncapsulationError(entry.plugin.name, token);
        }
        return base.resolve(token);
      },
      resolveOptional: <T>(token: InjectionToken<T>): T | undefined => {
        if (!this.isTokenVisibleToPlugin(entry, token.id)) {
          return undefined;
        }
        return base.resolveOptional(token);
      },
      has: (token: InjectionToken<unknown>): boolean => {
        return this.isTokenVisibleToPlugin(entry, token.id) && base.has(token);
      },
    };
  }

  private exportPluginProvider(pluginName: string, token: InjectionToken<unknown>): void {
    const ownSet = this.pluginOwnTokens.get(pluginName);
    if (!ownSet || !ownSet.has(token.id)) {
      throw new PluginEncapsulationError(
        pluginName,
        token,
        `Plugin "${pluginName}" cannot export provider "${token.description}" because it is not owned by "${pluginName}"`,
      );
    }
    let exportedSet = this.pluginExportedTokens.get(pluginName);
    if (!exportedSet) {
      exportedSet = new Set<symbol>();
      this.pluginExportedTokens.set(pluginName, exportedSet);
    }
    exportedSet.add(token.id);
    this.modules.addGlobalToken(token);
  }

  private registerEncapsulatedPluginProvider(
    entry: ResolvedPluginEntry,
    provider: AnyProviderDefinition,
    options?: PluginProviderRegisterOptions,
  ): void {
    const pluginName = entry.plugin.name;
    const regOpts: RegisterOptions | undefined =
      options?.override !== undefined ? { override: options.override } : undefined;

    if (isValueProvider(provider)) {
      this.container.register(provider, regOpts);
    } else if (isFactoryProvider(provider)) {
      const wrappedFactory: FactoryProvider<unknown> = {
        token: provider.token,
        ...(provider.scope !== undefined ? { scope: provider.scope } : {}),
        ...(provider.dispose !== undefined ? { dispose: provider.dispose } : {}),
        useFactory: (di) => provider.useFactory(this.createPluginScopedResolver(entry, di)),
      };
      this.container.register(wrappedFactory, regOpts);
    } else if (isClassProvider(provider)) {
      const depTokens = provider.inject ?? provider.useClass.inject ?? [];
      const wrappedClass: FactoryProvider<unknown> = {
        token: provider.token,
        ...(provider.scope !== undefined ? { scope: provider.scope } : {}),
        ...(provider.dispose !== undefined ? { dispose: provider.dispose } : {}),
        useFactory: (di) => {
          const scoped = this.createPluginScopedResolver(entry, di);
          const args = depTokens.map((depToken) => scoped.resolve(depToken));
          return new provider.useClass(...args);
        },
      };
      this.container.register(wrappedClass, regOpts);
    } else {
      if (!this.isTokenVisibleToPlugin(entry, provider.useExisting.id)) {
        throw new PluginEncapsulationError(pluginName, provider.useExisting);
      }
      this.container.register(provider, regOpts);
    }

    let ownSet = this.pluginOwnTokens.get(pluginName);
    if (!ownSet) {
      ownSet = new Set<symbol>();
      this.pluginOwnTokens.set(pluginName, ownSet);
    }
    ownSet.add(provider.token.id);

    if (options?.export === true) {
      this.exportPluginProvider(pluginName, provider.token);
    }
  }

  private recordPluginCleanup(pluginName: string, cleanup: () => void): void {
    let list = this.pluginCleanups.get(pluginName);
    if (!list) {
      list = [];
      this.pluginCleanups.set(pluginName, list);
    }
    list.push(cleanup);
  }

  private runPluginCleanups(pluginName: string): void {
    const list = this.pluginCleanups.get(pluginName);
    if (!list) return;
    for (let i = list.length - 1; i >= 0; i -= 1) {
      try {
        list[i]?.();
      } catch {
        // Best-effort cleanup of plugin event listeners / health checks / hooks
      }
    }
    this.pluginCleanups.delete(pluginName);
  }

  private buildPluginContext(entry: ResolvedPluginEntry): PluginContext {
    const pluginName = entry.plugin.name;
    const validatedConfig = this.validatedPluginConfigs.get(pluginName);
    const scopedResolver = this.createPluginScopedResolver(entry, this.container);
    const dynamicEvents = this.events as unknown as EventDispatcher<Record<string, unknown>>;

    return createPluginContext({
      plugin: entry.plugin,
      forgeVersion: this.forgeVersion,
      validatedConfig,
      logger: this.logger.child({
        plugin: pluginName,
        pluginVersion: entry.plugin.version,
      }),
      registerProvider: (provider, options) => {
        this.registerEncapsulatedPluginProvider(entry, provider, options);
      },
      exportProvider: (token) => {
        this.exportPluginProvider(pluginName, token);
      },
      resolve: (token) => scopedResolver.resolve(token),
      resolveOptional: (token) => scopedResolver.resolveOptional(token),
      has: (token) => scopedResolver.has(token),
      getConfig: <T = unknown>(key: string) => this.config.get<T>(key),
      getConfigOrThrow: <T = unknown>(key: string) => this.config.getOrThrow<T>(key),
      emitEvent: (eventName, payload) => dynamicEvents.emit(eventName, payload),
      onEvent: (eventName, handler) => {
        const unsub = dynamicEvents.on(eventName, handler);
        this.recordPluginCleanup(pluginName, unsub);
        return unsub;
      },
      addHook: (stage, handler, options) => {
        this.pluginHookSeq += 1;
        const hookId = options?.id ?? `__plugin:${pluginName}:${this.pluginHookSeq}`;
        const registeredId = this.hooks.add(
          stage,
          (hookCtx) => handler({ stage: hookCtx.stage }),
          {
            ...(options?.priority !== undefined ? { priority: options.priority } : {}),
            id: hookId,
          },
        );
        const remove = (): void => {
          this.hooks.remove(stage, registeredId);
        };
        this.recordPluginCleanup(pluginName, remove);
        return remove;
      },
      registerHealthCheck: (name, check) => {
        const unreg = this.health.register(name, check);
        this.recordPluginCleanup(pluginName, unreg);
        return unreg;
      },
    });
  }

  public async configure(): Promise<void> {
    this.assertNotTerminal('configure');
    if (this.currentState !== 'created') {
      return;
    }

    try {
      await this.transition('configuring');

      // Resolve plugin DAG and validate all plugin config schemas fail-fast at configure stage
      const orderedPlugins = this.plugins.resolve();
      for (const entry of orderedPlugins) {
        const validated = await validatePluginConfig(entry.plugin, entry.config);
        this.validatedPluginConfigs.set(entry.plugin.name, validated);
      }

      await this.hooks.runSequential('configure', { kernel: this, stage: 'configure' });

      // Compile module DAG early so configuration hooks execute in deterministic topological order
      const orderedModules = this.modules.compile();
      for (const mod of orderedModules) {
        if (mod.onConfigure !== undefined) {
          await mod.onConfigure({ moduleName: mod.name });
        }
      }

      await this.transition('configured');
    } catch (err: unknown) {
      await this.handleBootFailure('configure', err);
      throw err;
    }
  }

  public async register(): Promise<void> {
    this.assertNotTerminal('register');
    if (this.currentState === 'created') {
      await this.configure();
    }
    if (this.currentState !== 'configured') {
      return;
    }

    try {
      await this.transition('registering');

      const orderedPlugins = this.plugins.resolve();
      for (const entry of orderedPlugins) {
        if (!this.validatedPluginConfigs.has(entry.plugin.name)) {
          const validated = await validatePluginConfig(entry.plugin, entry.config);
          this.validatedPluginConfigs.set(entry.plugin.name, validated);
        }
        const ctx = this.buildPluginContext(entry);
        this.pluginContexts.set(entry.plugin.name, ctx);
        if (entry.plugin.register !== undefined) {
          await entry.plugin.register(ctx, this.validatedPluginConfigs.get(entry.plugin.name));
        }
        this.registeredPlugins.push(entry);
      }

      this.modules.compile();
      await this.hooks.runSequential('register', { kernel: this, stage: 'register' });
      await this.transition('registered');
    } catch (err: unknown) {
      await this.handleBootFailure('register', err);
      throw err;
    }
  }

  public async initialize(): Promise<void> {
    this.assertNotTerminal('initialize');
    if (this.currentState === 'created' || this.currentState === 'configured') {
      await this.register();
    }
    if (this.currentState !== 'registered') {
      return;
    }

    try {
      await this.transition('initializing');

      for (const entry of this.registeredPlugins) {
        if (!this.plugins.has(entry.plugin.name)) continue;
        const ctx = this.pluginContexts.get(entry.plugin.name);
        if (ctx && entry.plugin.initialize !== undefined) {
          await entry.plugin.initialize(ctx);
        }
        this.initializedPlugins.push(entry);
      }

      const orderedModules = this.modules.getTopologicalOrder();
      for (const mod of orderedModules) {
        const ctx = this.createModuleContext(mod.name);
        if (mod.onInit !== undefined) {
          await mod.onInit(ctx);
        }
        this.initializedModules.push(mod);
      }

      await this.hooks.runSequential('initialize', { kernel: this, stage: 'initialize' });
      await this.transition('initialized');
    } catch (err: unknown) {
      await this.handleBootFailure('initialize', err);
      throw err;
    }
  }

  public async start(): Promise<void> {
    this.assertNotTerminal('start');
    if (this.currentState === 'ready') {
      return;
    }
    if (
      this.currentState === 'created' ||
      this.currentState === 'configured' ||
      this.currentState === 'registered'
    ) {
      await this.initialize();
    }
    if (this.currentState !== 'initialized') {
      throw new LifecycleError(
        `Cannot start kernel from state "${this.currentState}"`,
        { state: this.currentState },
      );
    }

    try {
      await this.transition('starting');
      this.plugins.resolve();
      this.plugins.lock();

      const orderedModules = this.modules.getTopologicalOrder();
      for (const mod of orderedModules) {
        if (mod.onStart !== undefined) {
          await mod.onStart(this.createModuleContext(mod.name));
        }
      }

      await this.hooks.runSequential('start', { kernel: this, stage: 'start' });
      await this.transition('started');

      for (const entry of this.initializedPlugins) {
        if (!this.plugins.has(entry.plugin.name)) continue;
        const ctx = this.pluginContexts.get(entry.plugin.name);
        if (ctx && entry.plugin.onReady !== undefined) {
          await entry.plugin.onReady(ctx);
        }
      }

      for (const mod of orderedModules) {
        if (mod.onReady !== undefined) {
          await mod.onReady(this.createModuleContext(mod.name));
        }
      }
      await this.hooks.runSequential('ready', { kernel: this, stage: 'ready' });
      await this.transition('ready');
    } catch (err: unknown) {
      await this.handleBootFailure('start', err);
      throw err;
    }
  }

  public async shutdown(): Promise<void> {
    if (
      this.currentState === 'shutdown' ||
      this.currentState === 'disposing' ||
      this.currentState === 'disposed' ||
      this.currentState === 'created'
    ) {
      return;
    }

    await this.transition('shutting_down');
    const errors: unknown[] = [];

    try {
      await this.hooks.runSequential('shutdown', { kernel: this, stage: 'shutdown' });
    } catch (err: unknown) {
      errors.push(err);
    }

    for (let i = this.initializedModules.length - 1; i >= 0; i -= 1) {
      const mod = this.initializedModules[i];
      if (!mod || mod.onShutdown === undefined) continue;
      try {
        await mod.onShutdown(this.createModuleContext(mod.name));
      } catch (err: unknown) {
        errors.push(err);
      }
    }
    this.initializedModules.length = 0;

    for (let i = this.initializedPlugins.length - 1; i >= 0; i -= 1) {
      const entry = this.initializedPlugins[i];
      if (!entry) continue;
      const ctx = this.pluginContexts.get(entry.plugin.name);
      if (ctx && entry.plugin.onShutdown !== undefined) {
        try {
          await entry.plugin.onShutdown(ctx);
        } catch (err: unknown) {
          errors.push(err);
        }
      }
    }
    this.initializedPlugins.length = 0;

    for (let i = this.registeredPlugins.length - 1; i >= 0; i -= 1) {
      const entry = this.registeredPlugins[i];
      if (entry) {
        this.runPluginCleanups(entry.plugin.name);
      }
    }
    this.registeredPlugins.length = 0;

    await this.transition('shutdown');

    if (errors.length > 0) {
      throw new AggregateError(
        errors,
        `${errors.length} error(s) occurred during kernel shutdown`,
      );
    }
  }

  public async dispose(): Promise<void> {
    if (this.currentState === 'disposed') {
      return;
    }

    const errors: unknown[] = [];

    if (
      this.currentState !== 'shutdown' &&
      this.currentState !== 'created' &&
      this.currentState !== 'failed'
    ) {
      try {
        await this.shutdown();
      } catch (err: unknown) {
        errors.push(err);
      }
    }

    await this.transition('disposing');

    try {
      await this.hooks.runSequential('dispose', { kernel: this, stage: 'dispose' });
    } catch (err: unknown) {
      errors.push(err);
    }

    try {
      await this.container.dispose();
    } catch (err: unknown) {
      errors.push(err);
    }

    this.health.clear();
    this.hooks.clear();
    await this.transition('disposed');
    this.events.clear();

    if (errors.length > 0) {
      throw new AggregateError(
        errors,
        `${errors.length} error(s) occurred during kernel disposal`,
      );
    }
  }

  private createModuleContext(moduleName: string): ModuleLifecycleContext {
    const resolver = this.modules.getModuleResolver(moduleName);
    return {
      moduleName,
      resolve: (token) => resolver.resolve(token),
      resolveOptional: (token) => resolver.resolveOptional(token),
      has: (token) => resolver.has(token),
    };
  }

  private async handleBootFailure(stage: LifecycleStage, error: unknown): Promise<void> {
    await this.events.emit('lifecycle:error', { stage, error });

    // Best-effort rollback of already-initialized modules in reverse topological order
    for (let i = this.initializedModules.length - 1; i >= 0; i -= 1) {
      const mod = this.initializedModules[i];
      if (!mod || mod.onShutdown === undefined) continue;
      try {
        await mod.onShutdown(this.createModuleContext(mod.name));
      } catch (rollbackErr: unknown) {
        this.logger.error('Error during boot rollback shutdown', {
          module: mod.name,
          error: rollbackErr,
        });
      }
    }
    this.initializedModules.length = 0;

    // Best-effort rollback of already-initialized plugins in reverse topological order
    for (let i = this.initializedPlugins.length - 1; i >= 0; i -= 1) {
      const entry = this.initializedPlugins[i];
      if (!entry) continue;
      const ctx = this.pluginContexts.get(entry.plugin.name);
      if (ctx && entry.plugin.onShutdown !== undefined) {
        try {
          await entry.plugin.onShutdown(ctx);
        } catch (rollbackErr: unknown) {
          this.logger.error('Error during plugin boot rollback shutdown', {
            plugin: entry.plugin.name,
            error: rollbackErr,
          });
        }
      }
    }
    this.initializedPlugins.length = 0;

    for (let i = this.registeredPlugins.length - 1; i >= 0; i -= 1) {
      const entry = this.registeredPlugins[i];
      if (entry) {
        this.runPluginCleanups(entry.plugin.name);
      }
    }
    this.registeredPlugins.length = 0;

    try {
      await this.container.dispose();
    } catch (disposeErr: unknown) {
      this.logger.error('Error disposing DI container during boot rollback', {
        error: disposeErr,
      });
    }

    this.health.clear();
    await this.transition('failed');
  }
}

export function createKernel(options: KernelOptions = {}): ApplicationKernel {
  return new ForgeKernel(options);
}
