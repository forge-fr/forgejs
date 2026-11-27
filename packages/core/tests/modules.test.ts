import { describe, expect, it } from 'vitest';
import {
  CircularModuleDependencyError,
  ConflictError,
  ModuleConfigurationError,
  ProviderNotVisibleError,
  createContainer,
  createModuleRegistry,
  createToken,
  defineModule,
} from '../src/index.js';

describe('@forge-fr/core — Encapsulated Module Registry', () => {
  it('enforces provider encapsulation: private providers stay hidden while exported providers work', () => {
    const PrivateSecretToken = createToken<string>('PrivateSecret');
    const PublicServiceToken = createToken<{ getSummary(): string }>('PublicService');
    const ConsumerServiceToken = createToken<string>('ConsumerService');

    const AuthModule = defineModule({
      name: 'auth',
      providers: [
        { token: PrivateSecretToken, useValue: 'internal-signing-key' },
        {
          token: PublicServiceToken,
          useFactory: (di) => {
            // Allowed: PublicService belongs to AuthModule so it can access PrivateSecretToken
            const key = di.resolve(PrivateSecretToken);
            return { getSummary: () => `signed-with:${key.length}` };
          },
        },
      ],
      exports: [PublicServiceToken],
    });

    const UsersModule = defineModule({
      name: 'users',
      imports: [AuthModule],
      providers: [
        {
          token: ConsumerServiceToken,
          useFactory: (di) => di.resolve(PublicServiceToken).getSummary(),
        },
      ],
      exports: [ConsumerServiceToken],
    });

    const container = createContainer();
    const registry = createModuleRegistry(container);
    registry.register(UsersModule);
    registry.compile();

    const usersScope = registry.getModuleResolver('users');
    expect(usersScope.resolve(ConsumerServiceToken)).toBe('signed-with:20');
    expect(usersScope.resolve(PublicServiceToken).getSummary()).toBe('signed-with:20');

    // SECURITY / ENCAPSULATION: UsersModule cannot directly resolve AuthModule's private provider
    expect(() => usersScope.resolve(PrivateSecretToken)).toThrow(ProviderNotVisibleError);
  });

  it('prevents provider inside importing module from accessing private provider of imported module', () => {
    const HiddenRepoToken = createToken<string>('HiddenRepo');
    const SnoopingServiceToken = createToken<string>('SnoopingService');

    const DataModule = defineModule({
      name: 'data',
      providers: [{ token: HiddenRepoToken, useValue: 'secret-db-handle' }],
      exports: [],
    });

    const ApiModule = defineModule({
      name: 'api',
      imports: [DataModule],
      providers: [
        {
          token: SnoopingServiceToken,
          useFactory: (di) => di.resolve(HiddenRepoToken),
        },
      ],
    });

    const container = createContainer();
    const registry = createModuleRegistry(container);
    registry.register(ApiModule);
    registry.compile();

    expect(() => registry.getModuleResolver('api').resolve(SnoopingServiceToken)).toThrow(
      ProviderNotVisibleError,
    );
  });

  it('prevents implicit transitive visibility unless explicitly re-exported', () => {
    const LeafToken = createToken<string>('Leaf');

    const LeafModule = defineModule({
      name: 'leaf',
      providers: [{ token: LeafToken, useValue: 'leaf-val' }],
      exports: [LeafToken],
    });

    const MiddleNoReexport = defineModule({
      name: 'middle-closed',
      imports: [LeafModule],
      exports: [],
    });

    const TopClosed = defineModule({
      name: 'top-closed',
      imports: [MiddleNoReexport],
    });

    const MiddleReexport = defineModule({
      name: 'middle-open',
      imports: [LeafModule],
      exports: [LeafToken],
    });

    const TopOpen = defineModule({
      name: 'top-open',
      imports: [MiddleReexport],
    });

    const closedRegistry = createModuleRegistry(createContainer());
    closedRegistry.register(TopClosed);
    closedRegistry.compile();
    expect(() => closedRegistry.getModuleResolver('top-closed').resolve(LeafToken)).toThrow(
      ProviderNotVisibleError,
    );

    const openRegistry = createModuleRegistry(createContainer());
    openRegistry.register(TopOpen);
    openRegistry.compile();
    expect(openRegistry.getModuleResolver('top-open').resolve(LeafToken)).toBe('leaf-val');
  });

  it('handles diamond module dependencies cleanly and computes deterministic topological order', () => {
    const SharedToken = createToken<string>('Shared');

    const SharedModule = defineModule({
      name: 'shared',
      providers: [{ token: SharedToken, useValue: 'shared-instance' }],
      exports: [SharedToken],
    });

    const BillingModule = defineModule({
      name: 'billing',
      imports: [SharedModule],
    });

    const OrdersModule = defineModule({
      name: 'orders',
      imports: [SharedModule],
    });

    const AppModule = defineModule({
      name: 'app',
      imports: [BillingModule, OrdersModule],
    });

    const registry = createModuleRegistry(createContainer());
    registry.register(AppModule);
    const order = registry.compile().map((m) => m.name);

    // Shared must initialize before billing & orders, and app last; Shared appears only once
    expect(order).toEqual(['shared', 'billing', 'orders', 'app']);
  });

  it('rejects circular module dependencies with exact dependency chain', () => {
    const modA: { name: string; imports?: unknown[] } = { name: 'module-a' };
    const modB: { name: string; imports?: unknown[] } = { name: 'module-b', imports: [modA] };
    modA.imports = [modB];

    const registry = createModuleRegistry(createContainer());
    registry.register(modA as ReturnType<typeof defineModule>);

    let caught: unknown;
    try {
      registry.compile();
    } catch (err: unknown) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(CircularModuleDependencyError);
    expect((caught as CircularModuleDependencyError).chain).toEqual([
      'module-a',
      'module-b',
      'module-a',
    ]);
  });

  it('rejects duplicate distinct module names and invalid exports of unregistered tokens', () => {
    const GhostToken = createToken<string>('Ghost');
    expect(() =>
      defineModule({
        name: '   ',
      }),
    ).toThrow(ModuleConfigurationError);

    const BadExportModule = defineModule({
      name: 'bad-export',
      exports: [GhostToken],
    });

    const reg1 = createModuleRegistry(createContainer());
    reg1.register(BadExportModule);
    expect(() => reg1.compile()).toThrow(ModuleConfigurationError);

    const DupA = defineModule({ name: 'duplicate' });
    const DupB = defineModule({ name: 'duplicate' });
    const reg2 = createModuleRegistry(createContainer());
    reg2.register(DupA);
    expect(() => reg2.register(DupB)).toThrow(ConflictError);
  });
});
