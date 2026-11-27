import { describe, expect, it } from 'vitest';
import { createPluginTestHarness } from '@forge-fr/testing';
import {
  DatabaseUniqueViolationError,
  createDatabaseToken,
  createPostgresPlugin,
  runInTransaction,
  type PostgresClientLike,
} from '../src/index.js';

const LIVE_DATABASE_URL = process.env.FORGE_TEST_DATABASE_URL;

describe.runIf(Boolean(LIVE_DATABASE_URL))(
  '@forge-fr/database Live PostgreSQL Integration Suite (requires FORGE_TEST_DATABASE_URL)',
  () => {
    it('executes real queries, transactions, health checks, and SQLSTATE 23505 normalization against PostgreSQL', async () => {
      const tokens = createDatabaseToken<PostgresClientLike>('live-pg');
      const plugin = createPostgresPlugin({
        adapterToken: tokens.adapter,
        clientToken: tokens.client,
        healthCheckName: 'live-postgres',
      });

      const harness = createPluginTestHarness({
        plugin,
        config: {
          url: LIVE_DATABASE_URL!,
          max: 4,
          connectTimeoutSeconds: 5,
        },
      });

      await harness.start();
      try {
        const adapter = harness.resolveExport(tokens.adapter);
        const sql = harness.resolveExport(tokens.client);

        const health = await harness.health();
        expect(health.status).toBe('ok');
        expect(health.checks['live-postgres']?.status).toBe('ok');

        const table = `forgejs_m41_it_${Date.now()}`;
        await sql.unsafe(
          `CREATE TEMP TABLE ${table} (id INT PRIMARY KEY, email TEXT UNIQUE NOT NULL)`,
        );

        await runInTransaction(adapter, async (tx) => {
          await tx.unsafe(`INSERT INTO ${table} (id, email) VALUES ($1, $2)`, [
            1,
            'alice@forgejs.dev',
          ]);
        });

        await expect(
          runInTransaction(adapter, async (tx) => {
            await tx.unsafe(`INSERT INTO ${table} (id, email) VALUES ($1, $2)`, [
              2,
              'alice@forgejs.dev',
            ]);
          }),
        ).rejects.toThrow(DatabaseUniqueViolationError);
      } finally {
        await harness.dispose();
      }
    });
  },
);
