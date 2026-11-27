# Encapsulated Modules

> Define modular boundaries with defineModule(), explicit exports, non-transitive encapsulation, and diamond deduplication.

- **Section**: Core Concepts
- **Packages**: @forge-fr/core
- **Version**: v1.0.0-rc.1
- **Updated**: 2026-11-26
- **HTML URL**: https://github.com/forge-fr/forgejs/docs/concepts/modules
- **Markdown URL**: https://github.com/forge-fr/forgejs/docs/concepts/modules.md
- **Source**: https://github.com/forge-fr/forgejs/blob/main/docs/architecture.md

## Private providers vs. explicit exports

Providers registered inside defineModule() are private by default. Downstream modules attempting to resolve an unexported token fail fast with ProviderNotVisibleError. Exports are non-transitive unless explicitly re-exported.

**File: `src/modules/billing.module.ts`**

```ts
import { createKernel, createToken, defineModule } from '@forge-fr/core';

const RepoToken = createToken<{ count(): number }>('BillingRepo');
export const BillingServiceToken = createToken<{ total(): number }>('BillingService');

export const BillingModule = defineModule({
  name: 'billing',
  providers: [
    { token: RepoToken, scope: 'singleton', useValue: { count: () => 12 } },
    {
      token: BillingServiceToken,
      scope: 'singleton',
      inject: [RepoToken] as const,
      useFactory: (repo) => ({ total: () => repo.count() * 100 }),
    },
  ],
  exports: [BillingServiceToken],
});

const kernel = createKernel({ modules: [BillingModule] });
await kernel.start();
const billing = kernel.container.resolve(BillingServiceToken);
console.info('Total cents:', billing.total());
```

## Diamond dependency deduplication & cycle checks

- If Modules B and C both import SharedModule A, createModuleRegistry() instantiates and initializes SharedModule A exactly once.
- Circular module imports throw CircularModuleDependencyError during boot before any providers run.
