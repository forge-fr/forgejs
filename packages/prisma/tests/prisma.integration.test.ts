import { describe, expect, it } from 'vitest';
import {
  DatabaseUniqueViolationError,
  createPostgresAdapter,
  runInTransaction,
} from '@forge-fr/database';
import { createPluginTestHarness } from '@forge-fr/testing';
import {
  createPrismaPlugin,
  createPrismaToken,
  type PrismaClientLike,
} from '../src/index.js';

const LIVE_DATABASE_URL = process.env.FORGE_TEST_DATABASE_URL;

describe.runIf(Boolean(LIVE_DATABASE_URL))(
  '@forge-fr/prisma Live PostgreSQL Integration Suite (requires FORGE_TEST_DATABASE_URL)',
  () => {
    it('executes real PostgreSQL connect, health check, transaction, and unique violation normalization through PrismaClientLike contract', async () => {
      const pg = createPostgresAdapter({
        url: LIVE_DATABASE_URL!,
        max: 4,
        connectTimeoutSeconds: 5,
      });

      // PrismaClientLike backed by a live PostgreSQL connection (mirroring Prisma 7 driver-adapter behavior)
      const pgBackedPrismaClient: PrismaClientLike = {
        async $connect() {
          await pg.connect();
        },
        async $disconnect() {
          await pg.disconnect();
        },
        async $queryRaw<T = unknown>(strings: TemplateStringsArray, ...values: unknown[]): Promise<T> {
          return (await pg.client(strings, ...values)) as unknown as T;
        },
        async $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T> {
          return (await pg.client.unsafe(query, values)) as unknown as T;
        },
        async $transaction<T>(fn: (tx: PrismaClientLike) => Promise<T>): Promise<T> {
          return pg.transaction!(async (txSql) => {
            const txPrisma: PrismaClientLike = {
              async $connect() {},
              async $disconnect() {},
              async $queryRaw<R = unknown>(
                strings: TemplateStringsArray,
                ...values: unknown[]
              ): Promise<R> {
                return (await txSql(strings, ...values)) as unknown as R;
              },
              async $queryRawUnsafe<R = unknown>(query: string, ...values: unknown[]): Promise<R> {
                return (await txSql.unsafe(query, values)) as unknown as R;
              },
            };
            return fn(txPrisma);
          });
        },
      };

      const tokens = createPrismaToken<PrismaClientLike>('live-prisma');
      const plugin = createPrismaPlugin<PrismaClientLike>({
        adapterToken: tokens.adapter,
        clientToken: tokens.client,
        healthCheckName: 'live-prisma-pg',
      });

      const harness = createPluginTestHarness({
        plugin,
        config: { client: pgBackedPrismaClient },
      });

      await harness.start();
      try {
        const adapter = harness.resolveExport(tokens.adapter);
        const prisma = harness.resolveExport(tokens.client);

        const health = await harness.health();
        expect(health.status).toBe('ok');
        expect(health.checks['live-prisma-pg']?.status).toBe('ok');

        const table = `forgejs_prisma_m42_it_${Date.now()}`;
        await prisma.$queryRawUnsafe!(
          `CREATE TEMP TABLE ${table} (id INT PRIMARY KEY, email TEXT UNIQUE NOT NULL)`,
        );

        await runInTransaction(adapter, async (tx) => {
          await tx.$queryRawUnsafe!(`INSERT INTO ${table} (id, email) VALUES ($1, $2)`, 1, 'prisma@forgejs.dev');
        });

        await expect(
          runInTransaction(adapter, async (tx) => {
            await tx.$queryRawUnsafe!(`INSERT INTO ${table} (id, email) VALUES ($1, $2)`, 2, 'prisma@forgejs.dev');
          }),
        ).rejects.toThrow(DatabaseUniqueViolationError);
      } finally {
        await harness.dispose();
      }
    });
  },
);
