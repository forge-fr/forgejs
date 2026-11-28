# Repository Pattern

> Keep business logic independent from your ORM by defining repository tokens that can be swapped cleanly in tests.

- **Section**: Database & Data Access
- **Packages**: @forge-fr/core, @forge-fr/database, @forge-fr/testing
- **Version**: v1.0.0
- **Updated**: 2026-11-27
- **HTML URL**: https://github.com/forge-fr/forgejs/docs/database/repository-pattern
- **Markdown URL**: https://github.com/forge-fr/forgejs/docs/database/repository-pattern.md
- **Source**: https://github.com/forge-fr/forgejs/blob/main/docs/data-and-auth.md

## Separate data access behind typed tokens

Define a simple repository interface with createToken<T>(), connect your PostgreSQL, Drizzle, or Prisma implementation in a data module, and swap it with an in-memory fake in unit tests using overrideProvider().

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
