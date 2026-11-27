import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { integer, pgTable, text } from 'drizzle-orm/pg-core';
import { DatabaseUniqueViolationError, runInTransaction } from '@forge-fr/database';
import { createPluginTestHarness } from '@forge-fr/testing';
import {
  createDrizzlePostgresPlugin,
  createDrizzleToken,
  type DrizzlePostgresClient,
} from '../src/index.js';

const LIVE_DATABASE_URL = process.env.FORGE_TEST_DATABASE_URL;

const tempUsers = pgTable('forgejs_drizzle_m42_users', {
  id: integer('id').primaryKey(),
  email: text('email').notNull(),
});

const schema = { tempUsers };

describe.runIf(Boolean(LIVE_DATABASE_URL))(
  '@forge-fr/drizzle Live PostgreSQL Integration Suite (requires FORGE_TEST_DATABASE_URL)',
  () => {
    it('executes real Drizzle ORM queries, transactions, health checks, and SQLSTATE 23505 normalization against PostgreSQL', async () => {
      const tokens = createDrizzleToken<DrizzlePostgresClient<typeof schema>>('live-drizzle');
      const plugin = createDrizzlePostgresPlugin<typeof schema>({
        adapterToken: tokens.adapter,
        dbToken: tokens.db,
        healthCheckName: 'live-drizzle-pg',
      });

      const harness = createPluginTestHarness({
        plugin,
        config: {
          url: LIVE_DATABASE_URL!,
          schema,
          max: 4,
          connectTimeoutSeconds: 5,
        },
      });

      await harness.start();
      try {
        const adapter = harness.resolveExport(tokens.adapter);
        const db = harness.resolveExport(tokens.db);

        const health = await harness.health();
        expect(health.status).toBe('ok');
        expect(health.checks['live-drizzle-pg']?.status).toBe('ok');

        await db.execute(
          sql`CREATE TEMP TABLE forgejs_drizzle_m42_users (id INT PRIMARY KEY, email TEXT UNIQUE NOT NULL)`,
        );

        await runInTransaction(adapter, async (tx) => {
          await tx.insert(tempUsers).values({ id: 1, email: 'drizzle@forgejs.dev' });
        });

        const rows = await db.select().from(tempUsers);
        expect(rows).toEqual([{ id: 1, email: 'drizzle@forgejs.dev' }]);

        await expect(
          runInTransaction(adapter, async (tx) => {
            await tx.insert(tempUsers).values({ id: 2, email: 'drizzle@forgejs.dev' });
          }),
        ).rejects.toThrow(DatabaseUniqueViolationError);
      } finally {
        await harness.dispose();
      }
    });
  },
);
