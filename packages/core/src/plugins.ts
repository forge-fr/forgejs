import type { DependencyResolver, InjectionToken } from './di.js';
import { ForgeError } from './errors.js';
import type { HealthCheckFn } from './health.js';
import type { HookRegistrationOptions } from './hooks.js';
import type { ForgeLogger } from './logger.js';
import type { AnyProviderDefinition } from './modules.js';
import { isValidSemVer, isValidSemVerRange, satisfiesRange } from './semver.js';

export const FORGE_CORE_VERSION = '1.0.0-rc.1';

const FORBIDDEN_PLUGIN_NAMES = new Set(['__proto__', 'constructor', 'prototype']);

export type PluginCapability =
  | 'di:register'
  | 'di:resolve'
  | 'config:read'
  | 'events:emit'
  | 'events:listen'
  | 'hooks:register'
  | 'http:route'
  | 'http:middleware'
  | 'http:hook'
  | 'health:register';

export type PluginHookStage =
  | 'configure'
  | 'register'
  | 'initialize'
  | 'start'
  | 'ready'
  | 'shutdown'
  | 'dispose';

export type PluginDependencySpec = readonly string[] | Readonly<Record<string, string>>;

export interface StandardSchemaIssueLike {
  readonly message: string;
  readonly path?: readonly (PropertyKey | { readonly key: PropertyKey })[] | undefined;
}

export interface StandardSchemaLike<TInput = unknown, TOutput = TInput> {
  readonly '~standard': {
    readonly version: 1;
    readonly vendor: string;
    readonly validate: (
      value: unknown,
    ) =>
      | { readonly value: TOutput; readonly issues?: undefined }
      | { readonly issues: readonly StandardSchemaIssueLike[] }
      | Promise<
          | { readonly value: TOutput; readonly issues?: undefined }
          | { readonly issues: readonly StandardSchemaIssueLike[] }
        >;
    readonly types?:
      | {
          readonly input: TInput;
          readonly output: TOutput;
        }
      | undefined;
  };
}

export interface PluginConfigIssue {
  readonly path: readonly (string | number)[];
  readonly message: string;
}

export interface PluginProviderRegisterOptions {
  readonly export?: boolean;
  readonly override?: boolean;
}

export interface PluginHookEvent {
  readonly stage: PluginHookStage;
}

export interface PluginContext<TConfig = unknown> extends DependencyResolver {
  readonly pluginName: string;
  readonly pluginVersion: string;
  readonly forgeVersion: string;
  readonly capabilities: readonly PluginCapability[];
  readonly logger: ForgeLogger;
  hasCapability(capability: PluginCapability): boolean;
  getPluginConfig(): TConfig;
  registerProvider(
    provider: AnyProviderDefinition,
    options?: PluginProviderRegisterOptions,
  ): void;
  exportProvider(token: InjectionToken<unknown>): void;
  getConfig<T = unknown>(key: string): T | undefined;
  getConfigOrThrow<T = unknown>(key: string): T;
  emitEvent(eventName: string, payload: unknown): Promise<void>;
  onEvent(
    eventName: string,
    handler: (payload: unknown) => void | Promise<void>,
  ): () => void;
  addHook(
    stage: PluginHookStage,
    handler: (payload: PluginHookEvent) => void | Promise<void>,
    options?: HookRegistrationOptions,
  ): () => void;
  registerHealthCheck(name: string, check: HealthCheckFn): () => void;
}

export interface ForgePluginDefinition<TConfig = unknown, TConfigInput = TConfig> {
  readonly name: string;
  readonly version: string;
  readonly forgeVersion: string;
  readonly dependencies?: PluginDependencySpec;
  readonly optionalDependencies?: PluginDependencySpec;
  readonly conflicts?: readonly string[];
  readonly capabilities?: readonly PluginCapability[];
  readonly configSchema?: StandardSchemaLike<TConfigInput, TConfig>;
  readonly register?: (ctx: PluginContext<TConfig>, config: TConfig) => void | Promise<void>;
  readonly initialize?: (ctx: PluginContext<TConfig>) => void | Promise<void>;
  readonly onReady?: (ctx: PluginContext<TConfig>) => void | Promise<void>;
  readonly onShutdown?: (ctx: PluginContext<TConfig>) => void | Promise<void>;
}

export interface ForgePlugin<TConfig = unknown, TConfigInput = TConfig> {
  readonly name: string;
  readonly version: string;
  readonly forgeVersion: string;
  readonly dependencies: Readonly<Record<string, string>>;
  readonly optionalDependencies: Readonly<Record<string, string>>;
  readonly conflicts: readonly string[];
  readonly capabilities: readonly PluginCapability[];
  readonly configSchema?: StandardSchemaLike<TConfigInput, TConfig>;
  readonly register?: (ctx: PluginContext<TConfig>, config: TConfig) => void | Promise<void>;
  readonly initialize?: (ctx: PluginContext<TConfig>) => void | Promise<void>;
  readonly onReady?: (ctx: PluginContext<TConfig>) => void | Promise<void>;
  readonly onShutdown?: (ctx: PluginContext<TConfig>) => void | Promise<void>;
}

export class PluginDefinitionError extends ForgeError {
  public constructor(message: string, details?: Record<string, unknown>) {
    super(message, {
      code: 'PLUGIN_DEFINITION_ERROR',
      statusCode: 500,
      expose: false,
      ...(details !== undefined ? { details } : {}),
    });
  }
}

export class PluginConflictError extends ForgeError {
  public constructor(message: string, details?: Record<string, unknown>) {
    super(message, {
      code: 'PLUGIN_CONFLICT',
      statusCode: 500,
      expose: false,
      ...(details !== undefined ? { details } : {}),
    });
  }
}

export class PluginCompatibilityError extends ForgeError {
  public constructor(message: string, details?: Record<string, unknown>) {
    super(message, {
      code: 'PLUGIN_COMPATIBILITY_ERROR',
      statusCode: 500,
      expose: false,
      ...(details !== undefined ? { details } : {}),
    });
  }
}

export class PluginDependencyError extends ForgeError {
  public constructor(message: string, details?: Record<string, unknown>) {
    super(message, {
      code: 'PLUGIN_DEPENDENCY_ERROR',
      statusCode: 500,
      expose: false,
      ...(details !== undefined ? { details } : {}),
    });
  }
}

export class CircularPluginDependencyError extends ForgeError {
  public readonly chain: readonly string[];

  public constructor(chain: readonly string[]) {
    super(`Circular plugin dependency detected: ${chain.join(' -> ')}`, {
      code: 'CIRCULAR_PLUGIN_DEPENDENCY',
      statusCode: 500,
      expose: false,
      details: { chain },
    });
    this.chain = Object.freeze([...chain]);
  }
}

export class PluginLifecycleError extends ForgeError {
  public constructor(message: string, details?: Record<string, unknown>) {
    super(message, {
      code: 'LIFECYCLE_ERROR',
      statusCode: 500,
      expose: false,
      ...(details !== undefined ? { details } : {}),
    });
  }
}

export class PluginCapabilityError extends ForgeError {
  public readonly pluginName: string;
  public readonly capability: PluginCapability;

  public constructor(pluginName: string, capability: PluginCapability) {
    super(
      `Plugin "${pluginName}" attempted an operation requiring undeclared capability "${capability}"`,
      {
        code: 'PLUGIN_CAPABILITY_DENIED',
        statusCode: 500,
        expose: false,
        details: { pluginName, capability },
      },
    );
    this.pluginName = pluginName;
    this.capability = capability;
  }
}

export class PluginConfigError extends ForgeError {
  public readonly pluginName: string;
  public readonly issues: readonly PluginConfigIssue[];

  public constructor(pluginName: string, issues: readonly PluginConfigIssue[]) {
    super(`Invalid configuration for plugin "${pluginName}"`, {
      code: 'PLUGIN_CONFIG_ERROR',
      statusCode: 500,
      expose: false,
      details: { pluginName, issues },
    });
    this.pluginName = pluginName;
    this.issues = Object.freeze([...issues]);
  }
}

export class PluginEncapsulationError extends ForgeError {
  public readonly pluginName: string;
  public readonly tokenDescription: string;

  public constructor(pluginName: string, token: InjectionToken<unknown>, message?: string) {
    super(
      message ??
        `Plugin "${pluginName}" cannot access provider "${token.description}" because it is private or belongs to an undeclared dependency`,
      {
        code: 'PLUGIN_PROVIDER_NOT_VISIBLE',
        statusCode: 500,
        expose: false,
        details: { pluginName, token: token.description },
      },
    );
    this.pluginName = pluginName;
    this.tokenDescription = token.description;
  }
}

function normalizeIssuePath(
  path: readonly (PropertyKey | { readonly key: PropertyKey })[] | undefined,
): readonly (string | number)[] {
  if (!path || path.length === 0) return Object.freeze([]);
  const normalized: (string | number)[] = [];
  for (const segment of path) {
    const key =
      typeof segment === 'object' && segment !== null && 'key' in segment ? segment.key : segment;
    if (typeof key === 'number') {
      normalized.push(key);
    } else if (typeof key === 'string') {
      normalized.push(key);
    } else {
      normalized.push(String(key));
    }
  }
  return Object.freeze(normalized);
}

export async function validatePluginConfig<TConfig, TConfigInput>(
  plugin: ForgePlugin<TConfig, TConfigInput>,
  rawConfig: unknown,
): Promise<TConfig> {
  if (plugin.configSchema === undefined) {
    return rawConfig as TConfig;
  }
  const result = await plugin.configSchema['~standard'].validate(rawConfig);
  if ('issues' in result && result.issues !== undefined) {
    const issues: PluginConfigIssue[] = result.issues.map((issue) => ({
      path: normalizeIssuePath(issue.path),
      message: issue.message,
    }));
    throw new PluginConfigError(plugin.name, issues);
  }
  return result.value;
}

export interface PluginContextRuntimeBridge<TConfig = unknown> {
  readonly plugin: ForgePlugin<TConfig, unknown>;
  readonly forgeVersion: string;
  readonly validatedConfig: TConfig;
  readonly logger: ForgeLogger;
  readonly registerProvider: (
    provider: AnyProviderDefinition,
    options?: PluginProviderRegisterOptions,
  ) => void;
  readonly exportProvider: (token: InjectionToken<unknown>) => void;
  readonly resolve: <T>(token: InjectionToken<T>) => T;
  readonly resolveOptional: <T>(token: InjectionToken<T>) => T | undefined;
  readonly has: (token: InjectionToken<unknown>) => boolean;
  readonly getConfig: <T = unknown>(key: string) => T | undefined;
  readonly getConfigOrThrow: <T = unknown>(key: string) => T;
  readonly emitEvent: (eventName: string, payload: unknown) => Promise<void>;
  readonly onEvent: (
    eventName: string,
    handler: (payload: unknown) => void | Promise<void>,
  ) => () => void;
  readonly addHook: (
    stage: PluginHookStage,
    handler: (payload: PluginHookEvent) => void | Promise<void>,
    options?: HookRegistrationOptions,
  ) => () => void;
  readonly registerHealthCheck: (name: string, check: HealthCheckFn) => () => void;
}

export function createPluginContext<TConfig = unknown>(
  bridge: PluginContextRuntimeBridge<TConfig>,
): PluginContext<TConfig> {
  const { plugin } = bridge;
  const allowed = new Set<PluginCapability>(plugin.capabilities);

  const requireCapability = (cap: PluginCapability): void => {
    if (!allowed.has(cap)) {
      throw new PluginCapabilityError(plugin.name, cap);
    }
  };

  const ctx: PluginContext<TConfig> = {
    pluginName: plugin.name,
    pluginVersion: plugin.version,
    forgeVersion: bridge.forgeVersion,
    capabilities: plugin.capabilities,
    logger: bridge.logger,
    hasCapability(capability: PluginCapability): boolean {
      return allowed.has(capability);
    },
    getPluginConfig(): TConfig {
      return bridge.validatedConfig;
    },
    registerProvider(
      provider: AnyProviderDefinition,
      options?: PluginProviderRegisterOptions,
    ): void {
      requireCapability('di:register');
      bridge.registerProvider(provider, options);
    },
    exportProvider(token: InjectionToken<unknown>): void {
      requireCapability('di:register');
      bridge.exportProvider(token);
    },
    resolve<T>(token: InjectionToken<T>): T {
      requireCapability('di:resolve');
      return bridge.resolve(token);
    },
    resolveOptional<T>(token: InjectionToken<T>): T | undefined {
      requireCapability('di:resolve');
      return bridge.resolveOptional(token);
    },
    has(token: InjectionToken<unknown>): boolean {
      requireCapability('di:resolve');
      return bridge.has(token);
    },
    getConfig<T = unknown>(key: string): T | undefined {
      requireCapability('config:read');
      return bridge.getConfig<T>(key);
    },
    getConfigOrThrow<T = unknown>(key: string): T {
      requireCapability('config:read');
      return bridge.getConfigOrThrow<T>(key);
    },
    emitEvent(eventName: string, payload: unknown): Promise<void> {
      requireCapability('events:emit');
      return bridge.emitEvent(eventName, payload);
    },
    onEvent(
      eventName: string,
      handler: (payload: unknown) => void | Promise<void>,
    ): () => void {
      requireCapability('events:listen');
      return bridge.onEvent(eventName, handler);
    },
    addHook(
      stage: PluginHookStage,
      handler: (payload: PluginHookEvent) => void | Promise<void>,
      options?: HookRegistrationOptions,
    ): () => void {
      requireCapability('hooks:register');
      return bridge.addHook(stage, handler, options);
    },
    registerHealthCheck(name: string, check: HealthCheckFn): () => void {
      requireCapability('health:register');
      return bridge.registerHealthCheck(name, check);
    },
  };

  return Object.freeze(ctx);
}

function assertValidPluginName(name: string, label: string): void {
  if (typeof name !== 'string' || name.trim().length === 0 || name.trim() !== name) {
    throw new PluginDefinitionError(`${label} must be a non-empty trimmed string`, {
      name,
    });
  }
  if (FORBIDDEN_PLUGIN_NAMES.has(name)) {
    throw new PluginDefinitionError(`${label} "${name}" is forbidden`, { name });
  }
}

function normalizeDependencyMap(
  ownerName: string,
  spec: PluginDependencySpec | undefined,
  fieldLabel: 'dependencies' | 'optionalDependencies',
): Readonly<Record<string, string>> {
  const map: Record<string, string> = Object.create(null) as Record<string, string>;
  if (spec === undefined) {
    return Object.freeze(map);
  }

  if (Array.isArray(spec)) {
    for (const depName of spec) {
      assertValidPluginName(depName, `${fieldLabel} entry of plugin "${ownerName}"`);
      if (depName === ownerName) {
        throw new PluginDefinitionError(
          `Plugin "${ownerName}" cannot declare itself in ${fieldLabel}`,
          { pluginName: ownerName, field: fieldLabel },
        );
      }
      map[depName] = '*';
    }
    return Object.freeze(map);
  }

  for (const [depName, range] of Object.entries(spec)) {
    assertValidPluginName(depName, `${fieldLabel} key of plugin "${ownerName}"`);
    if (depName === ownerName) {
      throw new PluginDefinitionError(
        `Plugin "${ownerName}" cannot declare itself in ${fieldLabel}`,
        { pluginName: ownerName, field: fieldLabel },
      );
    }
    if (!isValidSemVerRange(range)) {
      throw new PluginDefinitionError(
        `Plugin "${ownerName}" has invalid SemVer range "${range}" for ${fieldLabel}["${depName}"]`,
        { pluginName: ownerName, dependency: depName, range, field: fieldLabel },
      );
    }
    map[depName] = range;
  }

  return Object.freeze(map);
}

export function definePlugin<TConfig = unknown, TConfigInput = TConfig>(
  definition: ForgePluginDefinition<TConfig, TConfigInput>,
): ForgePlugin<TConfig, TConfigInput> {
  assertValidPluginName(definition.name, 'Plugin name');

  if (!isValidSemVer(definition.version)) {
    throw new PluginDefinitionError(
      `Plugin "${definition.name}" has invalid SemVer version "${definition.version}"`,
      { pluginName: definition.name, version: definition.version },
    );
  }

  if (!isValidSemVerRange(definition.forgeVersion)) {
    throw new PluginDefinitionError(
      `Plugin "${definition.name}" has invalid forgeVersion SemVer range "${definition.forgeVersion}"`,
      { pluginName: definition.name, forgeVersion: definition.forgeVersion },
    );
  }

  const dependencies = normalizeDependencyMap(
    definition.name,
    definition.dependencies,
    'dependencies',
  );
  const optionalDependencies = normalizeDependencyMap(
    definition.name,
    definition.optionalDependencies,
    'optionalDependencies',
  );

  for (const depName of Object.keys(dependencies)) {
    if (Object.prototype.hasOwnProperty.call(optionalDependencies, depName)) {
      throw new PluginDefinitionError(
        `Plugin "${definition.name}" cannot list "${depName}" in both dependencies and optionalDependencies`,
        { pluginName: definition.name, dependency: depName },
      );
    }
  }

  const conflictsSet = new Set<string>();
  for (const conflictName of definition.conflicts ?? []) {
    assertValidPluginName(conflictName, `conflicts entry of plugin "${definition.name}"`);
    if (conflictName === definition.name) {
      throw new PluginDefinitionError(
        `Plugin "${definition.name}" cannot declare a conflict with itself`,
        { pluginName: definition.name },
      );
    }
    if (
      Object.prototype.hasOwnProperty.call(dependencies, conflictName) ||
      Object.prototype.hasOwnProperty.call(optionalDependencies, conflictName)
    ) {
      throw new PluginDefinitionError(
        `Plugin "${definition.name}" cannot both depend on and conflict with "${conflictName}"`,
        { pluginName: definition.name, target: conflictName },
      );
    }
    conflictsSet.add(conflictName);
  }

  const capabilities = Object.freeze(Array.from(new Set(definition.capabilities ?? [])));
  const conflicts = Object.freeze(Array.from(conflictsSet));

  return Object.freeze({
    name: definition.name,
    version: definition.version,
    forgeVersion: definition.forgeVersion,
    dependencies,
    optionalDependencies,
    conflicts,
    capabilities,
    ...(definition.configSchema !== undefined ? { configSchema: definition.configSchema } : {}),
    ...(definition.register !== undefined ? { register: definition.register } : {}),
    ...(definition.initialize !== undefined ? { initialize: definition.initialize } : {}),
    ...(definition.onReady !== undefined ? { onReady: definition.onReady } : {}),
    ...(definition.onShutdown !== undefined ? { onShutdown: definition.onShutdown } : {}),
  });
}

export interface RegisteredPlugin<TConfig = unknown> {
  readonly plugin: ForgePlugin<TConfig, unknown>;
  readonly config: unknown;
  readonly registrationIndex: number;
}

export interface ResolvedPluginEntry<TConfig = unknown> {
  readonly plugin: ForgePlugin<TConfig, unknown>;
  readonly config: unknown;
  readonly resolvedDependencies: readonly string[];
  readonly resolvedOptionalDependencies: readonly string[];
  readonly missingOptionalDependencies: readonly string[];
}

export interface PluginRegistryOptions {
  readonly forgeVersion?: string;
}

export interface PluginRegistry {
  readonly forgeVersion: string;
  readonly locked: boolean;
  register<TConfig = unknown, TConfigInput = TConfig>(
    plugin: ForgePlugin<TConfig, TConfigInput> | ForgePluginDefinition<TConfig, TConfigInput>,
    config?: TConfigInput,
  ): this;
  removePlugin(name: string): boolean;
  has(name: string): boolean;
  get(name: string): RegisteredPlugin | undefined;
  list(): readonly RegisteredPlugin[];
  lock(): void;
  resolve(): readonly ResolvedPluginEntry[];
}

class ForgePluginRegistry implements PluginRegistry {
  public readonly forgeVersion: string;
  private isLocked = false;
  private nextIndex = 0;
  private readonly entries = new Map<string, RegisteredPlugin>();
  private cachedResolution: readonly ResolvedPluginEntry[] | null = null;

  public constructor(options: PluginRegistryOptions = {}) {
    const version = options.forgeVersion ?? FORGE_CORE_VERSION;
    if (!isValidSemVer(version)) {
      throw new PluginDefinitionError(`Invalid registry forgeVersion "${version}"`, {
        forgeVersion: version,
      });
    }
    this.forgeVersion = version;
  }

  public get locked(): boolean {
    return this.isLocked;
  }

  public register<TConfig = unknown, TConfigInput = TConfig>(
    pluginInput: ForgePlugin<TConfig, TConfigInput> | ForgePluginDefinition<TConfig, TConfigInput>,
    config?: TConfigInput,
  ): this {
    if (this.isLocked) {
      throw new PluginLifecycleError(
        `Cannot register plugin "${pluginInput.name}" after plugin registry is locked`,
        { pluginName: pluginInput.name },
      );
    }

    const plugin = definePlugin(pluginInput);

    if (this.entries.has(plugin.name)) {
      throw new PluginConflictError(`Plugin "${plugin.name}" is already registered`, {
        pluginName: plugin.name,
      });
    }

    if (!satisfiesRange(this.forgeVersion, plugin.forgeVersion)) {
      throw new PluginCompatibilityError(
        `Plugin "${plugin.name}@${plugin.version}" requires ForgeJS "${plugin.forgeVersion}", but active ForgeJS version is "${this.forgeVersion}"`,
        {
          pluginName: plugin.name,
          pluginVersion: plugin.version,
          requiredForgeVersion: plugin.forgeVersion,
          activeForgeVersion: this.forgeVersion,
        },
      );
    }

    const record: RegisteredPlugin = Object.freeze({
      plugin: plugin as ForgePlugin<unknown, unknown>,
      config,
      registrationIndex: this.nextIndex,
    });
    this.nextIndex += 1;
    this.entries.set(plugin.name, record);
    this.cachedResolution = null;
    return this;
  }

  public removePlugin(name: string): boolean {
    if (this.isLocked) {
      throw new PluginLifecycleError(
        `Cannot remove plugin "${name}" after plugin registry is locked`,
        { pluginName: name },
      );
    }
    const deleted = this.entries.delete(name);
    if (deleted) {
      this.cachedResolution = null;
    }
    return deleted;
  }

  public has(name: string): boolean {
    return this.entries.has(name);
  }

  public get(name: string): RegisteredPlugin | undefined {
    return this.entries.get(name);
  }

  public list(): readonly RegisteredPlugin[] {
    return Object.freeze(Array.from(this.entries.values()));
  }

  public lock(): void {
    this.isLocked = true;
  }

  public resolve(): readonly ResolvedPluginEntry[] {
    if (this.cachedResolution !== null) {
      return this.cachedResolution;
    }

    const orderedRegistrations = Array.from(this.entries.values()).sort(
      (a, b) => a.registrationIndex - b.registrationIndex,
    );

    // 1. Validate bidirectional conflicts across all registered plugins
    for (const entry of orderedRegistrations) {
      for (const conflictName of entry.plugin.conflicts) {
        if (this.entries.has(conflictName)) {
          throw new PluginConflictError(
            `Plugin "${entry.plugin.name}" conflicts with registered plugin "${conflictName}"`,
            { pluginName: entry.plugin.name, conflictsWith: conflictName },
          );
        }
      }
    }

    // 2. Validate required & present optional dependencies + build adjacency lists
    const edges = new Map<string, readonly string[]>();
    const metaByName = new Map<
      string,
      {
        readonly resolvedDependencies: readonly string[];
        readonly resolvedOptionalDependencies: readonly string[];
        readonly missingOptionalDependencies: readonly string[];
      }
    >();

    for (const entry of orderedRegistrations) {
      const { plugin } = entry;
      const resolvedDeps: string[] = [];
      const resolvedOptDeps: string[] = [];
      const missingOptDeps: string[] = [];

      for (const [depName, requiredRange] of Object.entries(plugin.dependencies)) {
        const target = this.entries.get(depName);
        if (target === undefined) {
          throw new PluginDependencyError(
            `Plugin "${plugin.name}" requires missing dependency "${depName}" (${requiredRange})`,
            {
              pluginName: plugin.name,
              missingDependency: depName,
              requiredRange,
            },
          );
        }
        if (!satisfiesRange(target.plugin.version, requiredRange)) {
          throw new PluginCompatibilityError(
            `Plugin "${plugin.name}" requires "${depName}" matching "${requiredRange}", but found "${target.plugin.version}"`,
            {
              pluginName: plugin.name,
              dependency: depName,
              requiredRange,
              actualVersion: target.plugin.version,
              optional: false,
            },
          );
        }
        resolvedDeps.push(depName);
      }

      for (const [optName, optRange] of Object.entries(plugin.optionalDependencies)) {
        const target = this.entries.get(optName);
        if (target === undefined) {
          missingOptDeps.push(optName);
          continue;
        }
        if (!satisfiesRange(target.plugin.version, optRange)) {
          throw new PluginCompatibilityError(
            `Plugin "${plugin.name}" optional dependency "${optName}" requires "${optRange}", but found "${target.plugin.version}"`,
            {
              pluginName: plugin.name,
              dependency: optName,
              requiredRange: optRange,
              actualVersion: target.plugin.version,
              optional: true,
            },
          );
        }
        resolvedOptDeps.push(optName);
      }

      edges.set(plugin.name, [...resolvedDeps, ...resolvedOptDeps]);
      metaByName.set(plugin.name, {
        resolvedDependencies: Object.freeze(resolvedDeps),
        resolvedOptionalDependencies: Object.freeze(resolvedOptDeps),
        missingOptionalDependencies: Object.freeze(missingOptDeps),
      });
    }

    // 3. Deterministic topological DFS with explicit cycle path trace
    const state = new Map<string, 'visiting' | 'visited'>();
    const stack: string[] = [];
    const sorted: ResolvedPluginEntry[] = [];

    const visit = (name: string): void => {
      const current = state.get(name);
      if (current === 'visited') return;
      if (current === 'visiting') {
        const cycleStart = stack.indexOf(name);
        const chain = [...stack.slice(cycleStart), name];
        throw new CircularPluginDependencyError(chain);
      }

      state.set(name, 'visiting');
      stack.push(name);

      const deps = edges.get(name) ?? [];
      for (const dep of deps) {
        visit(dep);
      }

      stack.pop();
      state.set(name, 'visited');

      const reg = this.entries.get(name)!;
      const meta = metaByName.get(name)!;
      sorted.push(
        Object.freeze({
          plugin: reg.plugin,
          config: reg.config,
          resolvedDependencies: meta.resolvedDependencies,
          resolvedOptionalDependencies: meta.resolvedOptionalDependencies,
          missingOptionalDependencies: meta.missingOptionalDependencies,
        }),
      );
    };

    for (const entry of orderedRegistrations) {
      visit(entry.plugin.name);
    }

    this.cachedResolution = Object.freeze(sorted);
    return this.cachedResolution;
  }
}

export function createPluginRegistry(options: PluginRegistryOptions = {}): PluginRegistry {
  return new ForgePluginRegistry(options);
}
