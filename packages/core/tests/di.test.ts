import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  CircularDependencyError,
  ConflictError,
  ContainerDisposedError,
  ProviderNotFoundError,
  ScopeViolationError,
  createContainer,
  createToken,
  isToken,
} from '../src/index.js';

describe('@forge-fr/core — Dependency Injection Container', () => {
  it('creates unique branded tokens even when descriptions match', () => {
    const tokenA = createToken<string>('Config');
    const tokenB = createToken<string>('Config');

    expect(isToken(tokenA)).toBe(true);
    expect(isToken({ description: 'fake' })).toBe(false);
    expect(tokenA).not.toBe(tokenB);
    expect(tokenA.id).not.toBe(tokenB.id);
    expect(tokenA.description).toBe('Config');

    const container = createContainer();
    container.register({ token: tokenA, useValue: 'value-a' });
    container.register({ token: tokenB, useValue: 'value-b' });

    expect(container.resolve(tokenA)).toBe('value-a');
    expect(container.resolve(tokenB)).toBe('value-b');
  });

  it('supports useValue, useFactory, useClass (explicit inject & static inject), and useExisting providers', () => {
    const PrefixToken = createToken<string>('Prefix');
    const RepoToken = createToken<UserRepo>('UserRepo');
    const ServiceToken = createToken<UserService>('UserService');
    const ServiceAliasToken = createToken<UserService>('UserServiceAlias');

    class UserRepo {
      public static readonly inject = [PrefixToken] as const;
      public constructor(public readonly prefix: string) {}
      public format(id: string): string {
        return `${this.prefix}:${id}`;
      }
    }

    class UserService {
      public constructor(private readonly repo: UserRepo) {}
      public getLabel(id: string): string {
        return `user(${this.repo.format(id)})`;
      }
    }

    const container = createContainer();
    container.register({ token: PrefixToken, useValue: 'prod' });
    container.register({ token: RepoToken, useClass: UserRepo });
    container.register({
      token: ServiceToken,
      useClass: UserService,
      inject: [RepoToken],
    });
    container.register({ token: ServiceAliasToken, useExisting: ServiceToken });

    const FactoryToken = createToken<string>('ComputedLabel');
    container.register({
      token: FactoryToken,
      useFactory: (di) => di.resolve(ServiceAliasToken).getLabel('42'),
    });

    expect(container.resolve(ServiceToken)).toBe(container.resolve(ServiceAliasToken));
    expect(container.resolve(FactoryToken)).toBe('user(prod:42)');
  });

  it('prevents duplicate registration by default and allows explicit override', () => {
    const PortToken = createToken<number>('Port');
    const container = createContainer();

    container.register({ token: PortToken, useValue: 3000 });
    expect(() => container.register({ token: PortToken, useValue: 4000 })).toThrow(ConflictError);

    container.register({ token: PortToken, useValue: 4000 }, { override: true });
    expect(container.resolve(PortToken)).toBe(4000);
  });

  it('enforces singleton, transient, and request scopes with strict cross-request isolation', () => {
    const SingletonToken = createToken<{ id: number }>('Singleton');
    const TransientToken = createToken<{ id: number }>('Transient');
    const RequestIdToken = createToken<string>('RequestId');
    const RequestCtxToken = createToken<{ reqId: string; seq: number }>('RequestCtx');

    let singletonSeq = 0;
    let transientSeq = 0;
    let requestSeq = 0;

    const container = createContainer();
    container.register({
      token: SingletonToken,
      scope: 'singleton',
      useFactory: () => ({ id: ++singletonSeq }),
    });
    container.register({
      token: TransientToken,
      scope: 'transient',
      useFactory: () => ({ id: ++transientSeq }),
    });
    container.register({
      token: RequestCtxToken,
      scope: 'request',
      useFactory: (di) => ({
        reqId: di.resolve(RequestIdToken),
        seq: ++requestSeq,
      }),
    });

    // Singleton returns same instance everywhere
    const s1 = container.resolve(SingletonToken);
    const s2 = container.resolve(SingletonToken);
    expect(s1).toBe(s2);
    expect(singletonSeq).toBe(1);

    // Transient returns fresh instance every call
    const t1 = container.resolve(TransientToken);
    const t2 = container.resolve(TransientToken);
    expect(t1).not.toBe(t2);
    expect(transientSeq).toBe(2);

    // Request scope cannot be resolved directly from root container
    expect(() => container.resolve(RequestCtxToken)).toThrow(ScopeViolationError);

    // Isolated child scopes for two concurrent requests
    const scopeA = container.createScope();
    scopeA.register({ token: RequestIdToken, useValue: 'req-A' });

    const scopeB = container.createScope();
    scopeB.register({ token: RequestIdToken, useValue: 'req-B' });

    const ctxA1 = scopeA.resolve(RequestCtxToken);
    const ctxA2 = scopeA.resolve(RequestCtxToken);
    const ctxB1 = scopeB.resolve(RequestCtxToken);

    expect(ctxA1).toBe(ctxA2);
    expect(ctxA1).not.toBe(ctxB1);
    expect(ctxA1.reqId).toBe('req-A');
    expect(ctxB1.reqId).toBe('req-B');

    // Child scopes share root singletons
    expect(scopeA.resolve(SingletonToken)).toBe(s1);
    expect(scopeB.resolve(SingletonToken)).toBe(s1);
  });

  it('SECURITY: blocks captive dependencies (singleton injecting a request-scoped provider)', () => {
    const CurrentUserToken = createToken<{ tenantId: string }>('CurrentUser');
    const CachedReportServiceToken = createToken<{ tenantId: string }>('CachedReportService');

    const container = createContainer();
    container.register({
      token: CurrentUserToken,
      scope: 'request',
      useFactory: () => ({ tenantId: 'tenant-1' }),
    });
    container.register({
      token: CachedReportServiceToken,
      scope: 'singleton',
      useFactory: (di) => di.resolve(CurrentUserToken),
    });

    const reqScope = container.createScope();
    expect(() => reqScope.resolve(CachedReportServiceToken)).toThrow(ScopeViolationError);
  });

  it('detects direct, indirect, and alias circular dependencies with exact resolution chain', () => {
    const TokenA = createToken<unknown>('ServiceA');
    const TokenB = createToken<unknown>('ServiceB');
    const TokenC = createToken<unknown>('ServiceC');

    const container = createContainer();
    container.register({ token: TokenA, useFactory: (di) => di.resolve(TokenB) });
    container.register({ token: TokenB, useFactory: (di) => di.resolve(TokenC) });
    container.register({ token: TokenC, useFactory: (di) => di.resolve(TokenA) });

    let caught: unknown;
    try {
      container.resolve(TokenA);
    } catch (err: unknown) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(CircularDependencyError);
    const circular = caught as CircularDependencyError;
    expect(circular.code).toBe('DI_CIRCULAR_DEPENDENCY');
    expect(circular.chain).toEqual(['ServiceA', 'ServiceB', 'ServiceC', 'ServiceA']);

    // Self-referential alias cycle
    const Alias1 = createToken<string>('Alias1');
    const Alias2 = createToken<string>('Alias2');
    const aliasContainer = createContainer();
    aliasContainer.register({ token: Alias1, useExisting: Alias2 });
    aliasContainer.register({ token: Alias2, useExisting: Alias1 });

    expect(() => aliasContainer.resolve(Alias1)).toThrow(CircularDependencyError);
  });

  it('throws ProviderNotFoundError for missing tokens and returns undefined for resolveOptional', () => {
    const MissingToken = createToken<string>('Missing');
    const container = createContainer();

    expect(container.has(MissingToken)).toBe(false);
    expect(container.resolveOptional(MissingToken)).toBeUndefined();
    expect(() => container.resolve(MissingToken)).toThrow(ProviderNotFoundError);
  });

  it('runs async disposal hooks in reverse instantiation order (LIFO) and prevents post-disposal use', async () => {
    const order: string[] = [];
    const DbToken = createToken<string>('Database');
    const CacheToken = createToken<string>('Cache');
    const ReqResourceToken = createToken<string>('ReqResource');

    const container = createContainer();
    container.register({
      token: DbToken,
      useFactory: () => {
        order.push('init:db');
        return 'db-conn';
      },
      dispose: async (val) => {
        await Promise.resolve();
        order.push(`dispose:${val}`);
      },
    });
    container.register({
      token: CacheToken,
      useFactory: (di) => {
        di.resolve(DbToken);
        order.push('init:cache');
        return 'cache-conn';
      },
      dispose: (val) => {
        order.push(`dispose:${val}`);
      },
    });
    container.register({
      token: ReqResourceToken,
      scope: 'request',
      useFactory: () => {
        order.push('init:req');
        return 'req-tx';
      },
      dispose: (val) => {
        order.push(`dispose:${val}`);
      },
    });

    const scope = container.createScope();
    expect(scope.resolve(CacheToken)).toBe('cache-conn');
    expect(scope.resolve(ReqResourceToken)).toBe('req-tx');

    // Disposing child request scope disposes only request-scoped instances, leaving root alive
    await scope.dispose();
    expect(order).toEqual(['init:db', 'init:cache', 'init:req', 'dispose:req-tx']);
    expect(() => scope.resolve(ReqResourceToken)).toThrow(ContainerDisposedError);
    expect(container.resolve(DbToken)).toBe('db-conn');

    // Disposing root disposes singletons in LIFO order (cache before db)
    await container.dispose();
    expect(order).toEqual([
      'init:db',
      'init:cache',
      'init:req',
      'dispose:req-tx',
      'dispose:cache-conn',
      'dispose:db-conn',
    ]);
    expect(() => container.resolve(DbToken)).toThrow(ContainerDisposedError);
  });

  it('continues running remaining disposal hooks even when one fails, throwing AggregateError', async () => {
    const cleaned: string[] = [];
    const FirstToken = createToken<string>('First');
    const SecondToken = createToken<string>('Second');

    const container = createContainer();
    container.register({
      token: FirstToken,
      useFactory: () => 'first',
      dispose: () => {
        cleaned.push('first');
      },
    });
    container.register({
      token: SecondToken,
      useFactory: (di) => {
        di.resolve(FirstToken);
        return 'second';
      },
      dispose: () => {
        cleaned.push('second-throws');
        throw new Error('close failed');
      },
    });

    container.resolve(SecondToken);
    await expect(container.dispose()).rejects.toBeInstanceOf(AggregateError);
    expect(cleaned).toEqual(['second-throws', 'first']);
  });

  it('property-based: validates arbitrary acyclic chains and rejects arbitrary cycles', () => {
    fc.assert(
      fc.property(fc.integer({ min: 2, max: 10 }), (length) => {
        const tokens = Array.from({ length }, (_, idx) => createToken<number>(`Node${idx}`));
        const acyclic = createContainer();
        acyclic.register({ token: tokens[0]!, useValue: 1 });
        for (let i = 1; i < length; i += 1) {
          const prev = tokens[i - 1]!;
          acyclic.register({
            token: tokens[i]!,
            useFactory: (di) => di.resolve(prev) + 1,
          });
        }
        expect(acyclic.resolve(tokens[length - 1]!)).toBe(length);

        const cyclic = createContainer();
        for (let i = 0; i < length; i += 1) {
          const next = tokens[(i + 1) % length]!;
          cyclic.register({
            token: tokens[i]!,
            useFactory: (di) => di.resolve(next),
          });
        }
        expect(() => cyclic.resolve(tokens[0]!)).toThrow(CircularDependencyError);
      }),
      { numRuns: 30 },
    );
  });
});
