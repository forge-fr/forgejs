# Repository Pattern

> Decouple domain services from ORM specifics using typed DI repository tokens and explicit transaction propagation.

- **Section**: Database & Data Access
- **Packages**: @forge-fr/core, @forge-fr/database, @forge-fr/testing
- **Version**: v1.0.0-rc.1
- **Updated**: 2026-11-26
- **HTML URL**: https://github.com/forge-fr/forgejs/docs/database/repository-pattern
- **Markdown URL**: https://github.com/forge-fr/forgejs/docs/database/repository-pattern.md
- **Source**: https://github.com/forge-fr/forgejs/blob/main/docs/data-and-auth.md

## Port interfaces & provider overrides

Define domain repository interfaces behind createToken<T>(), bind PostgreSQL/Drizzle/Prisma implementations inside infrastructure modules, and swap them cleanly in unit tests via overrideProvider().

**File: `src/modules/orders/orders.repository.ts`**

```ts
import { createToken, defineModule } from '@forge-fr/core';
import { DefaultDrizzleTokens } from '@forge-fr/drizzle';

export interface OrderRecord {
  readonly id: string;
  readonly totalCents: number;
}

export interface OrderRepository {
  findById(id: string): Promise<OrderRecord | null>;
}

export const OrderRepositoryToken = createToken<OrderRepository>('OrderRepository');

export const OrderDataModule = defineModule({
  name: 'orders-data',
  providers: [
    {
      token: OrderRepositoryToken,
      scope: 'singleton',
      inject: [DefaultDrizzleTokens.db] as const,
      useFactory: (_db): OrderRepository => ({
        async findById(id) {
          return { id, totalCents: 4200 };
        },
      }),
    },
  ],
  exports: [OrderRepositoryToken],
});
```
