import { secret } from '@forge-fr/core';
import {
  DatabaseUniqueViolationError,
  DefaultDatabaseTokens,
  createDatabaseToken,
  createPostgresAdapter,
  createPostgresPlugin,
  createUnitOfWork,
  defineRepository,
  type DatabaseAdapter,
  type PostgresClientLike,
} from '@forge-fr/database';
import { createPluginTestHarness } from '@forge-fr/testing';
import { describe, expect, it } from 'vitest';

interface FakeStoreClient {
  readonly id: string;
  readonly rows: Map<string, string>;
}

function createFakeStoreAdapter(options?: {
  failCommitWithCode?: string;
}): {
  adapter: DatabaseAdapter<FakeStoreClient, FakeStoreClient>;
  committedRows: Map<string, string>;
  txCount: number;
} {
  const committedRows = new Map<string, string>();
  let txCount = 0;

  const rootClient: FakeStoreClient = {
    id: 'root',
    rows: committedRows,
  };

  const adapter: DatabaseAdapter<FakeStoreClient, FakeStoreClient> = {
    name: 'fake-store',
    driver: 'memory-sql',
    state: 'connected',
    client: rootClient,
    async connect() {
      // no-op
    },
    async disconnect() {
      // no-op
    },
    async ping() {
      return { ok: true, latencyMs: 0 };
    },
    async transaction<T>(fn: (tx: FakeStoreClient) => Promise<T>): Promise<T> {
      txCount += 1;
      const staged = new Map<string, string>(committedRows);
      const txClient: FakeStoreClient = {
        id: `tx-${txCount}`,
        rows: staged,
      };
      const result = await fn(txClient);
      if (options?.failCommitWithCode) {
        throw Object.assign(new Error('Commit failed'), {
          code: options.failCommitWithCode,
          constraint_name: 'orders_code_key',
        });
      }
      committedRows.clear();
      for (const [k, v] of staged.entries()) {
        committedRows.set(k, v);
      }
      return result;
    },
  };

  return {
    adapter,
    committedRows,
    get txCount() {
      return txCount;
    },
  };
}

const UsersRepository = defineRepository(
  (client: FakeStoreClient) => ({
    clientId: client.id,
    insert(id: string, email: string): void {
      client.rows.set(`user:${id}`, email);
    },
    findById(id: string): string | undefined {
      return client.rows.get(`user:${id}`);
    },
  }),
  { name: 'UsersRepository' },
);

const AuditLogsRepository = defineRepository(
  (client: FakeStoreClient) => ({
    clientId: client.id,
    record(id: string, action: string): void {
      client.rows.set(`audit:${id}`, action);
    },
  }),
  { name: 'AuditLogsRepository' },
);

describe('@forge-fr/database — UnitOfWork, TransactionContext & defineRepository (Milestone 4)', () => {
  it('binds multiple repositories to the same transaction client and fires afterCommit hooks only after commit', async () => {
    const fake = createFakeStoreAdapter();
    const uow = createUnitOfWork(fake.adapter);

    expect(UsersRepository.name).toBe('UsersRepository');
    const rootUsers = uow.repository(UsersRepository);
    expect(rootUsers.clientId).toBe('root');

    const lifecycleEvents: string[] = [];

    const createdId = await uow.run(async (ctx) => {
      expect(ctx.depth).toBe(0);
      const usersA = ctx.repository(UsersRepository);
      const usersB = ctx.repository(UsersRepository);
      const audits = ctx.repository(AuditLogsRepository);

      // Repository instances are memoized per TransactionContext
      expect(usersA).toBe(usersB);
      expect(usersA.clientId).toBe('tx-1');
      expect(audits.clientId).toBe('tx-1');

      ctx.afterCommit(() => {
        // Must see committed state when afterCommit executes
        lifecycleEvents.push(`afterCommit:1:${fake.committedRows.get('user:u1') ?? 'missing'}`);
      });
      ctx.afterCommit(async () => {
        lifecycleEvents.push('afterCommit:2');
      });
      ctx.afterRollback(() => {
        lifecycleEvents.push('afterRollback:should-not-run');
      });

      usersA.insert('u1', 'ada@forgejs.dev');
      audits.record('a1', 'user.created');

      // Before commit finishes, committedRows has not yet been updated nor have hooks fired
      expect(fake.committedRows.has('user:u1')).toBe(false);
      expect(lifecycleEvents).toEqual([]);

      return 'u1';
    });

    expect(createdId).toBe('u1');
    expect(fake.committedRows.get('user:u1')).toBe('ada@forgejs.dev');
    expect(fake.committedRows.get('audit:a1')).toBe('user.created');
    expect(lifecycleEvents).toEqual(['afterCommit:1:ada@forgejs.dev', 'afterCommit:2']);
  });

  it('discards staged writes, skips afterCommit hooks, and runs afterRollback hooks in LIFO order on failure', async () => {
    const fake = createFakeStoreAdapter();
    const uow = createUnitOfWork(fake.adapter);
    const events: string[] = [];

    await expect(
      uow.run(async (ctx) => {
        const users = ctx.repository(UsersRepository);
        const audits = ctx.repository(AuditLogsRepository);

        ctx.afterCommit(() => {
          events.push('commit-hook');
        });
        ctx.afterRollback(() => {
          events.push('rollback:first-registered');
        });
        ctx.afterRollback(async () => {
          events.push('rollback:second-registered');
        });

        users.insert('u2', 'grace@forgejs.dev');
        audits.record('a2', 'user.attempt');

        throw Object.assign(new Error('duplicate key value violates unique constraint'), {
          code: '23505',
          constraint_name: 'users_email_key',
        });
      }),
    ).rejects.toThrow(DatabaseUniqueViolationError);

    expect(fake.committedRows.size).toBe(0);
    expect(events).toEqual(['rollback:second-registered', 'rollback:first-registered']);
  });

  it('reuses parent TransactionContext on nested uow.run({ parent }) and defers commit hooks to root completion', async () => {
    const fake = createFakeStoreAdapter();
    const uow = createUnitOfWork(fake.adapter);
    const events: string[] = [];

    await uow.run(async (rootCtx) => {
      expect(rootCtx.depth).toBe(0);
      const rootUsers = rootCtx.repository(UsersRepository);
      rootUsers.insert('u1', 'root@forgejs.dev');
      rootCtx.afterCommit(() => {
        events.push('commit:root');
      });

      await uow.run(
        async (nestedCtx) => {
          expect(nestedCtx.depth).toBe(1);
          expect(nestedCtx.tx).toBe(rootCtx.tx);
          // Shares memoized repository instance with parent transaction
          expect(nestedCtx.repository(UsersRepository)).toBe(rootUsers);

          const audits = nestedCtx.repository(AuditLogsRepository);
          audits.record('a1', 'nested.action');
          nestedCtx.afterCommit(() => {
            events.push('commit:nested');
          });
        },
        { parent: rootCtx },
      );

      // Nested commit hooks must NOT run until the root transaction commits
      expect(events).toEqual([]);
      expect(fake.txCount).toBe(1);
    });

    expect(fake.txCount).toBe(1);
    expect(fake.committedRows.get('user:u1')).toBe('root@forgejs.dev');
    expect(fake.committedRows.get('audit:a1')).toBe('nested.action');
    expect(events).toEqual(['commit:root', 'commit:nested']);
  });

  it('registers and exports UnitOfWork automatically via createPostgresPlugin and createDatabaseToken', async () => {
    const fn = async (): Promise<Record<string, unknown>[]> => [{ ok: 1 }];
    const fakeSql = Object.assign(fn, {
      unsafe: async () => [],
      begin: async <T>(
        a: string | ((tx: PostgresClientLike) => Promise<T>),
        b?: (tx: PostgresClientLike) => Promise<T>,
      ): Promise<T> => {
        const cb = typeof a === 'function' ? a : b!;
        return cb(fakeSql);
      },
      end: async () => {},
    }) as unknown as PostgresClientLike;

    const customTokens = createDatabaseToken<PostgresClientLike>('billing');
    expect(customTokens.unitOfWork.description).toBe('DatabaseUnitOfWork:billing');
    expect(DefaultDatabaseTokens.unitOfWork.description).toBe('DatabaseUnitOfWork:default');

    const adapter = createPostgresAdapter({
      url: secret('postgres://forge:pass@localhost:5432/app'),
      driverFactory: () => fakeSql,
    });

    const harness = createPluginTestHarness({
      plugin: createPostgresPlugin({
        adapterToken: customTokens.adapter,
        clientToken: customTokens.client,
        unitOfWorkToken: customTokens.unitOfWork,
      }),
      config: {
        url: secret('postgres://forge:pass@localhost:5432/app'),
        driverFactory: () => fakeSql,
      },
    });

    await harness.start();
    const resolvedUow = harness.resolveExport(customTokens.unitOfWork);
    const PingRepo = defineRepository((sql: PostgresClientLike) => ({
      async check(): Promise<number> {
        const rows = await sql`SELECT 1`;
        return rows.length;
      },
    }));

    const count = await resolvedUow.run(async (ctx) => ctx.repository(PingRepo).check());
    expect(count).toBe(1);

    await adapter.connect();
    await adapter.disconnect();
    await harness.dispose();
  });
});
