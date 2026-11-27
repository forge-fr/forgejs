import { ConflictError, ForgeError } from './errors.js';
import type {
  ClassProvider,
  Container,
  DependencyResolver,
  FactoryProvider,
  InjectionToken,
  ProviderDefinition,
  ValueProvider,
} from './di.js';

/**
 * Heterogeneous provider definition accepted in module provider lists.
 * `any` is justified here (Rule 5) because `ProviderDefinition<T>` is invariant in `T`
 * due to covariant `useValue` and contravariant `dispose`.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyProviderDefinition = ProviderDefinition<any>;

export interface ModuleConfigureContext {
  readonly moduleName: string;
}

export interface ModuleLifecycleContext extends DependencyResolver {
  readonly moduleName: string;
}

export interface ModuleDefinition {
  readonly name: string;
  readonly imports?: readonly ForgeModule[];
  readonly providers?: readonly AnyProviderDefinition[];
  readonly exports?: readonly InjectionToken<unknown>[];
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly onConfigure?: (ctx: ModuleConfigureContext) => void | Promise<void>;
  readonly onInit?: (ctx: ModuleLifecycleContext) => void | Promise<void>;
  readonly onStart?: (ctx: ModuleLifecycleContext) => void | Promise<void>;
  readonly onReady?: (ctx: ModuleLifecycleContext) => void | Promise<void>;
  readonly onShutdown?: (ctx: ModuleLifecycleContext) => void | Promise<void>;
}

const MODULE_BRAND: unique symbol = Symbol.for('@forge-fr/core.ForgeModule');

export interface ForgeModule extends ModuleDefinition {
  readonly [MODULE_BRAND]: true;
  readonly imports: readonly ForgeModule[];
  readonly providers: readonly AnyProviderDefinition[];
  readonly exports: readonly InjectionToken<unknown>[];
  readonly metadata: Readonly<Record<string, unknown>>;
}

export class ModuleConfigurationError extends ForgeError {
  public constructor(message: string, details?: Record<string, unknown>) {
    super(message, {
      code: 'MODULE_CONFIGURATION_ERROR',
      statusCode: 500,
      expose: false,
      ...(details !== undefined ? { details } : {}),
    });
  }
}

export class CircularModuleDependencyError extends ForgeError {
  public readonly chain: readonly string[];

  public constructor(chain: readonly string[]) {
    super(`Circular module dependency detected: ${chain.join(' -> ')}`, {
      code: 'MODULE_CIRCULAR_DEPENDENCY',
      statusCode: 500,
      expose: false,
      details: { chain },
    });
    this.chain = chain;
  }
}

export class ProviderNotVisibleError extends ForgeError {
  public readonly moduleName: string;
  public readonly tokenDescription: string;

  public constructor(moduleName: string, token: InjectionToken<unknown>) {
    super(
      `Module "${moduleName}" cannot access provider "${token.description}" because it is private or not imported`,
      {
        code: 'MODULE_PROVIDER_NOT_VISIBLE',
        statusCode: 500,
        expose: false,
        details: { moduleName, token: token.description },
      },
    );
    this.moduleName = moduleName;
    this.tokenDescription = token.description;
  }
}

export interface ModuleRegistryOptions {
  readonly globalTokens?: Iterable<InjectionToken<unknown>>;
}

export interface ModuleRegistry {
  register(mod: ForgeModule): this;
  addGlobalToken(token: InjectionToken<unknown>): this;
  compile(): readonly ForgeModule[];
  getTopologicalOrder(): readonly ForgeModule[];
  getModule(name: string): ForgeModule | undefined;
  getModuleResolver(name: string): DependencyResolver;
  readonly isCompiled: boolean;
}

export function defineModule(definition: ModuleDefinition): ForgeModule {
  if (typeof definition.name !== 'string' || definition.name.trim().length === 0) {
    throw new ModuleConfigurationError('Module name must be a non-empty string');
  }

  const normalized: ForgeModule = {
    [MODULE_BRAND]: true,
    name: definition.name.trim(),
    imports: Object.freeze([...(definition.imports ?? [])]),
    providers: Object.freeze([...(definition.providers ?? [])]),
    exports: Object.freeze([...(definition.exports ?? [])]),
    metadata: Object.freeze({ ...(definition.metadata ?? {}) }),
    ...(definition.onConfigure !== undefined ? { onConfigure: definition.onConfigure } : {}),
    ...(definition.onInit !== undefined ? { onInit: definition.onInit } : {}),
    ...(definition.onStart !== undefined ? { onStart: definition.onStart } : {}),
    ...(definition.onReady !== undefined ? { onReady: definition.onReady } : {}),
    ...(definition.onShutdown !== undefined ? { onShutdown: definition.onShutdown } : {}),
  };

  return Object.freeze(normalized);
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

function createScopedResolver(
  moduleName: string,
  base: DependencyResolver,
  visibleTokenIds: ReadonlySet<symbol>,
): DependencyResolver {
  return {
    resolve<T>(token: InjectionToken<T>): T {
      if (!visibleTokenIds.has(token.id)) {
        throw new ProviderNotVisibleError(moduleName, token);
      }
      return base.resolve(token);
    },
    resolveOptional<T>(token: InjectionToken<T>): T | undefined {
      if (!visibleTokenIds.has(token.id)) {
        return undefined;
      }
      return base.resolveOptional(token);
    },
    has(token: InjectionToken<unknown>): boolean {
      return visibleTokenIds.has(token.id) && base.has(token);
    },
  };
}

class ForgeModuleRegistry implements ModuleRegistry {
  private readonly rootModules: ForgeModule[] = [];
  private readonly modulesByName = new Map<string, ForgeModule>();
  private readonly visibleTokensByModule = new Map<string, Set<symbol>>();
  private readonly exportedTokensByModule = new Map<string, Set<symbol>>();
  private readonly globalTokenIds = new Set<symbol>();
  private topologicalOrder: ForgeModule[] = [];
  private compiled = false;

  public constructor(
    private readonly container: Container,
    options: ModuleRegistryOptions = {},
  ) {
    if (options.globalTokens) {
      for (const token of options.globalTokens) {
        this.globalTokenIds.add(token.id);
      }
    }
  }

  public get isCompiled(): boolean {
    return this.compiled;
  }

  public addGlobalToken(token: InjectionToken<unknown>): this {
    this.globalTokenIds.add(token.id);
    for (const set of this.visibleTokensByModule.values()) {
      set.add(token.id);
    }
    return this;
  }

  public register(mod: ForgeModule): this {
    if (this.compiled) {
      throw new ModuleConfigurationError(
        `Cannot register module "${mod.name}" after module registry has been compiled`,
      );
    }
    const existing = this.modulesByName.get(mod.name);
    if (existing !== undefined && existing !== mod) {
      throw new ConflictError(`Module "${mod.name}" is already registered with a different definition`);
    }
    this.modulesByName.set(mod.name, mod);
    if (!this.rootModules.includes(mod)) {
      this.rootModules.push(mod);
    }
    return this;
  }

  public compile(): readonly ForgeModule[] {
    if (this.compiled) {
      return this.topologicalOrder;
    }

    const visited = new Set<ForgeModule>();
    const visiting = new Set<ForgeModule>();
    const stack: ForgeModule[] = [];
    const ordered: ForgeModule[] = [];
    const seenByName = new Map<string, ForgeModule>();

    const visit = (mod: ForgeModule): void => {
      const existingByName = seenByName.get(mod.name);
      if (existingByName !== undefined && existingByName !== mod) {
        throw new ConflictError(
          `Duplicate module name "${mod.name}" encountered in module graph`,
        );
      }
      seenByName.set(mod.name, mod);

      if (visiting.has(mod)) {
        const cycleStart = stack.indexOf(mod);
        const chain = [...stack.slice(cycleStart), mod].map((item) => item.name);
        throw new CircularModuleDependencyError(chain);
      }
      if (visited.has(mod)) {
        return;
      }

      visiting.add(mod);
      stack.push(mod);

      for (const imported of mod.imports ?? []) {
        visit(imported);
      }

      stack.pop();
      visiting.delete(mod);
      visited.add(mod);
      ordered.push(mod);
      this.modulesByName.set(mod.name, mod);
    };

    for (const rootMod of this.rootModules) {
      visit(rootMod);
    }

    // Build visibility & validate exports in topological order (dependencies first)
    for (const mod of ordered) {
      const ownTokens = new Set<symbol>();
      for (const provider of mod.providers ?? []) {
        ownTokens.add(provider.token.id);
      }

      const importedExports = new Set<symbol>();
      for (const imported of mod.imports ?? []) {
        const expSet = this.exportedTokensByModule.get(imported.name);
        if (expSet) {
          for (const tokenId of expSet) {
            importedExports.add(tokenId);
          }
        }
      }

      const moduleExports = new Set<symbol>();
      for (const exportToken of mod.exports ?? []) {
        if (!ownTokens.has(exportToken.id) && !importedExports.has(exportToken.id)) {
          throw new ModuleConfigurationError(
            `Module "${mod.name}" cannot export token "${exportToken.description}" because it is neither provided by "${mod.name}" nor exported by its direct imports`,
            { moduleName: mod.name, token: exportToken.description },
          );
        }
        moduleExports.add(exportToken.id);
      }
      this.exportedTokensByModule.set(mod.name, moduleExports);

      const visible = new Set<symbol>([
        ...this.globalTokenIds,
        ...ownTokens,
        ...importedExports,
      ]);
      this.visibleTokensByModule.set(mod.name, visible);

      // Register module providers into shared DI container with strict module visibility wrappers
      for (const provider of mod.providers ?? []) {
        this.registerEncapsulatedProvider(mod.name, provider, visible);
      }
    }

    this.topologicalOrder = ordered;
    this.compiled = true;
    return this.topologicalOrder;
  }

  public getTopologicalOrder(): readonly ForgeModule[] {
    if (!this.compiled) {
      return this.compile();
    }
    return this.topologicalOrder;
  }

  public getModule(name: string): ForgeModule | undefined {
    return this.modulesByName.get(name);
  }

  public getModuleResolver(name: string): DependencyResolver {
    if (!this.compiled) {
      this.compile();
    }
    const visible = this.visibleTokensByModule.get(name);
    if (!visible) {
      throw new ModuleConfigurationError(`Module "${name}" is not registered`);
    }
    return createScopedResolver(name, this.container, visible);
  }

  private registerEncapsulatedProvider(
    moduleName: string,
    provider: AnyProviderDefinition,
    visible: ReadonlySet<symbol>,
  ): void {
    if (isValueProvider(provider)) {
      this.container.register(provider);
      return;
    }

    if (isFactoryProvider(provider)) {
      const wrappedFactory: FactoryProvider<unknown> = {
        token: provider.token,
        ...(provider.scope !== undefined ? { scope: provider.scope } : {}),
        ...(provider.dispose !== undefined ? { dispose: provider.dispose } : {}),
        useFactory: (di) => provider.useFactory(createScopedResolver(moduleName, di, visible)),
      };
      this.container.register(wrappedFactory);
      return;
    }

    if (isClassProvider(provider)) {
      const depTokens = provider.inject ?? provider.useClass.inject ?? [];
      const wrappedClass: FactoryProvider<unknown> = {
        token: provider.token,
        ...(provider.scope !== undefined ? { scope: provider.scope } : {}),
        ...(provider.dispose !== undefined ? { dispose: provider.dispose } : {}),
        useFactory: (di) => {
          const scoped = createScopedResolver(moduleName, di, visible);
          const args = depTokens.map((depToken) => scoped.resolve(depToken));
          return new provider.useClass(...args);
        },
      };
      this.container.register(wrappedClass);
      return;
    }

    // AliasProvider: verify target visibility when resolved
    if (!visible.has(provider.useExisting.id)) {
      throw new ProviderNotVisibleError(moduleName, provider.useExisting);
    }
    this.container.register(provider);
  }
}

export function createModuleRegistry(
  container: Container,
  options: ModuleRegistryOptions = {},
): ModuleRegistry {
  return new ForgeModuleRegistry(container, options);
}
