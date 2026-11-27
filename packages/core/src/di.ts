import { ConflictError, ForgeError } from './errors.js';

const TOKEN_BRAND: unique symbol = Symbol.for('@forge-fr/core.InjectionToken');

export type ProviderScope = 'singleton' | 'transient' | 'request';

export interface InjectionToken<T> {
  readonly [TOKEN_BRAND]: true;
  readonly id: symbol;
  readonly description: string;
  /** Phantom type marker for compile-time inference only; never assigned at runtime. */
  readonly __type?: T;
}

export type InjectableConstructor<T> = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  new (...args: any[]): T;
  readonly inject?: readonly InjectionToken<unknown>[];
};

export type Disposer<T> = (instance: T) => void | Promise<void>;

export interface ValueProvider<T> {
  readonly token: InjectionToken<T>;
  readonly useValue: T;
  readonly dispose?: Disposer<T>;
}

export interface FactoryProvider<T> {
  readonly token: InjectionToken<T>;
  readonly useFactory: (resolver: DependencyResolver) => T;
  readonly scope?: ProviderScope;
  readonly dispose?: Disposer<T>;
}

export interface ClassProvider<T> {
  readonly token: InjectionToken<T>;
  readonly useClass: InjectableConstructor<T>;
  readonly inject?: readonly InjectionToken<unknown>[];
  readonly scope?: ProviderScope;
  readonly dispose?: Disposer<T>;
}

export interface AliasProvider<T> {
  readonly token: InjectionToken<T>;
  readonly useExisting: InjectionToken<T>;
}

export type ProviderDefinition<T = unknown> =
  | ValueProvider<T>
  | FactoryProvider<T>
  | ClassProvider<T>
  | AliasProvider<T>;

export interface RegisterOptions {
  readonly override?: boolean;
}

export interface DependencyResolver {
  resolve<T>(token: InjectionToken<T>): T;
  resolveOptional<T>(token: InjectionToken<T>): T | undefined;
  has(token: InjectionToken<unknown>): boolean;
}

export interface Container extends DependencyResolver {
  register<T>(provider: ProviderDefinition<T>, options?: RegisterOptions): this;
  createScope(): Container;
  dispose(): Promise<void>;
  readonly isDisposed: boolean;
  readonly isRequestScope: boolean;
}

export class ProviderNotFoundError extends ForgeError {
  public readonly tokenDescription: string;

  public constructor(token: InjectionToken<unknown>) {
    super(`No provider registered for token "${token.description}"`, {
      code: 'DI_PROVIDER_NOT_FOUND',
      statusCode: 500,
      expose: false,
      details: { token: token.description },
    });
    this.tokenDescription = token.description;
  }
}

export class CircularDependencyError extends ForgeError {
  public readonly chain: readonly string[];

  public constructor(chain: readonly string[]) {
    super(`Circular dependency detected: ${chain.join(' -> ')}`, {
      code: 'DI_CIRCULAR_DEPENDENCY',
      statusCode: 500,
      expose: false,
      details: { chain },
    });
    this.chain = chain;
  }
}

export class ScopeViolationError extends ForgeError {
  public constructor(message: string, details?: Record<string, unknown>) {
    super(message, {
      code: 'DI_SCOPE_VIOLATION',
      statusCode: 500,
      expose: false,
      ...(details !== undefined ? { details } : {}),
    });
  }
}

export class ContainerDisposedError extends ForgeError {
  public constructor(isRequestScope: boolean) {
    super(
      isRequestScope
        ? 'Cannot use request scope container after it has been disposed'
        : 'Cannot use root container after it has been disposed',
      {
        code: 'DI_CONTAINER_DISPOSED',
        statusCode: 500,
        expose: false,
      },
    );
  }
}

export function createToken<T>(description: string): InjectionToken<T> {
  const token: InjectionToken<T> = {
    [TOKEN_BRAND]: true,
    id: Symbol(description),
    description,
  };
  return Object.freeze(token);
}

export function isToken(value: unknown): value is InjectionToken<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    TOKEN_BRAND in value &&
    (value as Record<symbol, unknown>)[TOKEN_BRAND] === true
  );
}

interface DisposableRecord {
  readonly tokenDescription: string;
  readonly instance: unknown;
  readonly dispose: Disposer<unknown>;
}

function isValueProvider<T>(provider: ProviderDefinition<T>): provider is ValueProvider<T> {
  return 'useValue' in provider;
}

function isFactoryProvider<T>(provider: ProviderDefinition<T>): provider is FactoryProvider<T> {
  return 'useFactory' in provider;
}

function isClassProvider<T>(provider: ProviderDefinition<T>): provider is ClassProvider<T> {
  return 'useClass' in provider;
}

class ForgeContainer implements Container {
  private readonly providers = new Map<symbol, ProviderDefinition<unknown>>();
  private readonly instances = new Map<symbol, unknown>();
  private readonly disposables: DisposableRecord[] = [];
  private readonly parent: ForgeContainer | undefined;
  private disposed = false;

  public constructor(parent?: ForgeContainer) {
    this.parent = parent;
  }

  public get isDisposed(): boolean {
    return this.disposed;
  }

  public get isRequestScope(): boolean {
    return this.parent !== undefined;
  }

  private get root(): ForgeContainer {
    return this.parent ? this.parent.root : this;
  }

  private assertActive(): void {
    if (this.disposed) {
      throw new ContainerDisposedError(this.isRequestScope);
    }
    if (this.parent?.isDisposed) {
      throw new ContainerDisposedError(false);
    }
  }

  public register<T>(provider: ProviderDefinition<T>, options: RegisterOptions = {}): this {
    this.assertActive();
    const id = provider.token.id;
    if (this.providers.has(id) && options.override !== true) {
      throw new ConflictError(
        `Provider for token "${provider.token.description}" is already registered`,
      );
    }
    this.providers.set(id, provider as ProviderDefinition<unknown>);
    this.instances.delete(id);

    if (isValueProvider(provider)) {
      this.instances.set(id, provider.useValue);
      if (provider.dispose !== undefined) {
        this.disposables.push({
          tokenDescription: provider.token.description,
          instance: provider.useValue,
          dispose: provider.dispose as Disposer<unknown>,
        });
      }
    }
    return this;
  }

  public has(token: InjectionToken<unknown>): boolean {
    this.assertActive();
    if (this.providers.has(token.id)) {
      return true;
    }
    return this.parent ? this.parent.has(token) : false;
  }

  public resolve<T>(token: InjectionToken<T>): T {
    this.assertActive();
    return this.resolveWithStack(token, []);
  }

  public resolveOptional<T>(token: InjectionToken<T>): T | undefined {
    this.assertActive();
    if (!this.has(token)) {
      return undefined;
    }
    return this.resolveWithStack(token, []);
  }

  public createScope(): Container {
    this.assertActive();
    return new ForgeContainer(this);
  }

  public async dispose(): Promise<void> {
    if (this.disposed) {
      return;
    }
    this.disposed = true;

    const errors: unknown[] = [];
    for (let i = this.disposables.length - 1; i >= 0; i -= 1) {
      const record = this.disposables[i];
      if (!record) continue;
      try {
        await record.dispose(record.instance);
      } catch (err: unknown) {
        errors.push(err);
      }
    }

    this.disposables.length = 0;
    this.instances.clear();
    this.providers.clear();

    if (errors.length > 0) {
      throw new AggregateError(
        errors,
        `${errors.length} error(s) occurred while disposing DI container`,
      );
    }
  }

  private lookupProvider(
    tokenId: symbol,
  ): { provider: ProviderDefinition<unknown>; owner: ForgeContainer } | undefined {
    const local = this.providers.get(tokenId);
    if (local !== undefined) {
      return { provider: local, owner: this };
    }
    return this.parent?.lookupProvider(tokenId);
  }

  private createStackResolver(stack: readonly InjectionToken<unknown>[]): DependencyResolver {
    return {
      resolve: <U>(depToken: InjectionToken<U>): U => this.resolveWithStack(depToken, stack),
      resolveOptional: <U>(depToken: InjectionToken<U>): U | undefined => {
        this.assertActive();
        if (!this.has(depToken)) {
          return undefined;
        }
        return this.resolveWithStack(depToken, stack);
      },
      has: (depToken: InjectionToken<unknown>): boolean => this.has(depToken),
    };
  }

  private resolveWithStack<T>(
    token: InjectionToken<T>,
    stack: readonly InjectionToken<unknown>[],
  ): T {
    this.assertActive();

    const cycleIndex = stack.findIndex((item) => item.id === token.id);
    if (cycleIndex !== -1) {
      const chain = [...stack.slice(cycleIndex), token].map((item) => item.description);
      throw new CircularDependencyError(chain);
    }

    const found = this.lookupProvider(token.id);
    if (!found) {
      throw new ProviderNotFoundError(token);
    }

    const { provider, owner } = found;
    const nextStack = [...stack, token];

    if (isValueProvider(provider)) {
      return provider.useValue as T;
    }

    if (!isFactoryProvider(provider) && !isClassProvider(provider)) {
      // AliasProvider
      return this.resolveWithStack(provider.useExisting, nextStack) as T;
    }

    const scope: ProviderScope = provider.scope ?? 'singleton';

    if (scope === 'request') {
      if (!this.isRequestScope) {
        throw new ScopeViolationError(
          `Cannot resolve request-scoped token "${token.description}" outside a request scope (or from inside a singleton provider)`,
          { token: token.description, scope: 'request' },
        );
      }

      if (this.instances.has(token.id)) {
        return this.instances.get(token.id) as T;
      }

      const instance = this.instantiate(provider, this, nextStack);
      this.instances.set(token.id, instance);
      if (provider.dispose !== undefined) {
        this.disposables.push({
          tokenDescription: token.description,
          instance,
          dispose: provider.dispose,
        });
      }
      return instance as T;
    }

    if (scope === 'singleton') {
      // Always resolve and cache singletons in their owning container (root for root providers)
      // so a singleton can never capture a request-scoped dependency.
      const singletonHost = owner.isRequestScope ? owner : this.root;
      if (singletonHost.instances.has(token.id)) {
        return singletonHost.instances.get(token.id) as T;
      }

      const instance = singletonHost.instantiate(provider, singletonHost, nextStack);
      singletonHost.instances.set(token.id, instance);
      if (provider.dispose !== undefined) {
        singletonHost.disposables.push({
          tokenDescription: token.description,
          instance,
          dispose: provider.dispose,
        });
      }
      return instance as T;
    }

    // Transient scope: instantiate fresh using current scope resolver without retaining references
    return this.instantiate(provider, this, nextStack) as T;
  }

  private instantiate(
    provider: FactoryProvider<unknown> | ClassProvider<unknown>,
    resolverHost: ForgeContainer,
    stack: readonly InjectionToken<unknown>[],
  ): unknown {
    const resolver = resolverHost.createStackResolver(stack);

    if (isFactoryProvider(provider)) {
      return provider.useFactory(resolver);
    }

    const depTokens = provider.inject ?? provider.useClass.inject ?? [];
    const args = depTokens.map((depToken) => resolver.resolve(depToken));
    return new provider.useClass(...args);
  }
}

export function createContainer(): Container {
  return new ForgeContainer();
}
