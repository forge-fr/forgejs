# Encapsulated Modules

> Organize features with defineModule(), keep internal helpers private by default, and share only explicit exports.

- **Section**: Core Concepts
- **Packages**: @forge-fr/core
- **Version**: v1.0.0
- **Updated**: 2026-11-27
- **HTML URL**: https://github.com/forge-fr/forgejs/docs/concepts/modules
- **Markdown URL**: https://github.com/forge-fr/forgejs/docs/concepts/modules.md
- **Source**: https://github.com/forge-fr/forgejs/blob/main/docs/architecture.md

## Private by default, shared only when exported

Services registered inside defineModule() stay private to that module unless you list their tokens in exports. If another module tries to access a private token, ForgeJS stops immediately with ProviderNotVisibleError.

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

## Shared module deduplication & loop protection

- If two different modules both import the same SharedModule, ForgeJS registers and initializes SharedModule only once.
- Circular module imports fail right at startup with CircularModuleDependencyError before any code runs.
