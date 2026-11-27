# @forge-fr/prisma

Official Prisma ORM adapter and ForgeJS plugin preserving your generated `PrismaClient` API while standardizing lifecycle connection, graceful shutdown, health probes, transactions, and Prisma error normalization.

## Features

- Preserves 100% of your generated `PrismaClient` types (`Prisma v5/v6/v7+`, including driver adapters).
- Automatic `$connect()` on kernel `initialize`, health checks in `kernel.health`, and graceful `$disconnect()` on `onShutdown`.
- `normalizePrismaError()` mapping Prisma codes (`P2002`, `P2003`, `P2011`, `P2024`, `P2034`, `P1001`, `P1002`, `P1008`, `P1017`) and driver adapter SQLSTATE codes into ForgeJS `DatabaseError` subclasses (`expose: false`).
- Standardized transaction execution mapping ForgeJS isolation levels to Prisma isolation enums.
