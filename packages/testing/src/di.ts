import type { AnyProviderDefinition, ApplicationKernel } from '@forge-fr/core';
import type { ForgeHttpApp } from '@forge-fr/http';

export type ProviderTarget = ForgeHttpApp | ApplicationKernel;

function isHttpApp(target: ProviderTarget): target is ForgeHttpApp {
  return 'kernel' in target;
}

export function overrideProvider(
  target: ProviderTarget,
  provider: AnyProviderDefinition,
): void {
  if (isHttpApp(target)) {
    target.registerProvider(provider, { override: true });
    return;
  }
  target.registerProvider(provider, { override: true });
}
