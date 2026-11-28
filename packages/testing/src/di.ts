import type {
  AnyProviderDefinition,
  ApplicationKernel,
  DependencyResolver,
  InjectionToken,
  ProviderScope,
} from '@forge-fr/core';
import type { ForgeHttpApp } from '@forge-fr/http';

export type ProviderTarget = ForgeHttpApp | ApplicationKernel;

/**
 * Strongly typed DI override descriptor created via `overrideValue()` or `overrideFactory()`.
 * Allows mixing heterogeneously typed overrides in a single array without `any`.
 */
export interface TypedProviderOverride {
  readonly __brand: 'ForgeTypedOverride';
  toProvider(): AnyProviderDefinition;
}

export type TestOverride = TypedProviderOverride | AnyProviderDefinition;

function isHttpApp(target: ProviderTarget): target is ForgeHttpApp {
  return 'kernel' in target;
}

export function isTypedProviderOverride(value: unknown): value is TypedProviderOverride {
  return (
    typeof value === 'object' &&
    value !== null &&
    '__brand' in value &&
    (value as { __brand?: unknown }).__brand === 'ForgeTypedOverride' &&
    typeof (value as { toProvider?: unknown }).toProvider === 'function'
  );
}

/** Creates a compile-time type-checked value override for an `InjectionToken<T>`. */
export function overrideValue<T>(
  token: InjectionToken<T>,
  value: T,
): TypedProviderOverride {
  return {
    __brand: 'ForgeTypedOverride',
    toProvider: () => ({ token, useValue: value }),
  };
}

/** Creates a compile-time type-checked factory override for an `InjectionToken<T>`. */
export function overrideFactory<T>(
  token: InjectionToken<T>,
  useFactory: (resolver: DependencyResolver) => T | Promise<T>,
  scope?: ProviderScope,
): TypedProviderOverride {
  return {
    __brand: 'ForgeTypedOverride',
    toProvider: () => ({
      token,
      useFactory,
      ...(scope !== undefined ? { scope } : {}),
    }),
  };
}

export function overrideProvider(
  target: ProviderTarget,
  provider: TestOverride,
): void {
  const def = isTypedProviderOverride(provider) ? provider.toProvider() : provider;
  const kernel = isHttpApp(target) ? target.kernel : target;
  if (
    kernel.state === 'created' ||
    kernel.state === 'configured' ||
    kernel.state === 'registering'
  ) {
    kernel.registerProvider(def, { override: true });
    return;
  }
  kernel.container.register(def, { override: true });
  kernel.modules.addGlobalToken(def.token);
}

export function applyOverrides(
  target: ProviderTarget,
  overrides: readonly TestOverride[] | undefined,
): void {
  if (!overrides || overrides.length === 0) {
    return;
  }
  for (const entry of overrides) {
    overrideProvider(target, entry);
  }
}
