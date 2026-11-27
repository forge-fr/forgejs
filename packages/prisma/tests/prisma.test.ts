import { describe, expect, it } from 'vitest';
import { PluginConfigError } from '@forge-fr/core';
import {
  DatabaseConnectionError,
  DatabaseForeignKeyViolationError,
  DatabaseNotNullViolationError,
  DatabaseSerializationError,
  DatabaseTimeoutError,
  DatabaseUniqueViolationError,
  runInTransaction,
} from '@forge-fr/database';
import { createPluginTestHarness } from '@forge-fr/testing';
import {
  createPrismaAdapter,
  createPrismaPlugin,
  createPrismaToken,
  normalizePrismaError,
  prismaConfigSchema,
  type PrismaClientLike,
} from '../src/index.js';

interface FakeAppPrismaClient extends PrismaClientLike {
  readonly user: {
    findMany(): Promise<readonly { id: number; email: string }[]>;
  };
}

function createFakePrismaClient(options?: {
  failConnect?: boolean;
  failPing?: boolean;
  failTxCode?: string;
}): {
  client: FakeAppPrismaClient;
  events: string[];
  lastTxOptions: unknown;
} {
  const events: string[] = [];
  let lastTxOptions: unknown;

  const client: FakeAppPrismaClient = {
    user: {
      async findMany() {
        events.push('user.findMany');
        return [{ id: 1, email: 'alice@forgejs.dev' }];
      },
    },
    async $connect() {
      events.push('connect');
      if (options?.failConnect) {
        throw Object.assign(new Error('Can\'t reach database server at db:5432'), {
          code: 'P1001',
        });
      }
    },
    async $disconnect() {
      events.push('disconnect');
    },
    async $queryRaw() {
      events.push('queryRaw');
      if (options?.failPing) {
        throw Object.assign(new Error('Timed out fetching a new connection from the pool'), {
          code: 'P2024',
        });
      }
      return [{ ok: 1 }];
    },
    async $transaction<T>(
      fn: (tx: unknown) => Promise<T>,
      txOptions?: { readonly isolationLevel?: string; readonly maxWait?: number; readonly timeout?: number },
    ): Promise<T> {
      lastTxOptions = txOptions;
      events.push('transaction');
      if (options?.failTxCode) {
        throw Object.assign(new Error('Unique constraint failed on the fields: (`email`)'), {
          code: options.failTxCode,
          meta: { modelName: 'User', target: ['email'] },
        });
      }
      return fn(client);
    },
  };

  return {
    client,
    events,
    get lastTxOptions() {
      return lastTxOptions;
    },
  };
}

describe('@forge-fr/prisma Adapter & Plugin (M4.2)', () => {
  it('normalizes Prisma error codes and driver-adapter SQLSTATE errors with expose=false', () => {
    const p2002 = normalizePrismaError(
      Object.assign(new Error('Unique constraint failed'), {
        code: 'P2002',
        meta: { modelName: 'User', target: ['email'] },
      }),
    );
    expect(p2002).toBeInstanceOf(DatabaseUniqueViolationError);
    expect(p2002.driverCode).toBe('P2002');
    expect(p2002.table).toBe('User');
    expect(p2002.column).toBe('email');
    expect(p2002.expose).toBe(false);

    const p2003 = normalizePrismaError(
      Object.assign(new Error('Foreign key failed'), {
        code: 'P2003',
        meta: { field_name: 'org_id' },
      }),
    );
    expect(p2003).toBeInstanceOf(DatabaseForeignKeyViolationError);
    expect(p2003.constraint).toBe('org_id');

    const p2011 = normalizePrismaError(
      Object.assign(new Error('Null constraint violation'), {
        code: 'P2011',
        meta: { constraint: 'email' },
      }),
    );
    expect(p2011).toBeInstanceOf(DatabaseNotNullViolationError);

    const p2024 = normalizePrismaError(
      Object.assign(new Error('Connection pool timeout'), { code: 'P2024' }),
    );
    expect(p2024).toBeInstanceOf(DatabaseTimeoutError);
    expect(p2024.retryable).toBe(true);

    const p2034 = normalizePrismaError(
      Object.assign(new Error('Transaction failed due to a write conflict or a deadlock'), {
        code: 'P2034',
      }),
    );
    expect(p2034).toBeInstanceOf(DatabaseSerializationError);
    expect(p2034.retryable).toBe(true);

    const p1001 = normalizePrismaError(
      Object.assign(new Error('Cannot reach database server'), { code: 'P1001' }),
    );
    expect(p1001).toBeInstanceOf(DatabaseConnectionError);

    const p1008 = normalizePrismaError(
      Object.assign(new Error('Operations timed out'), { code: 'P1008' }),
    );
    expect(p1008).toBeInstanceOf(DatabaseTimeoutError);

    // Driver adapter SQLSTATE fallback (e.g. @prisma/adapter-pg)
    const driverErr = normalizePrismaError(
      Object.assign(new Error('duplicate key'), { code: '23505', constraint_name: 'users_pkey' }),
    );
    expect(driverErr).toBeInstanceOf(DatabaseUniqueViolationError);
    expect(driverErr.sqlState).toBe('23505');
  });

  it('validates Prisma configuration via Standard Schema v1', async () => {
    const fake = createFakePrismaClient();
    const okClient = await prismaConfigSchema['~standard'].validate({
      client: fake.client,
      transactionMaxWaitMs: 2000,
      transactionTimeoutMs: 5000,
    });
    expect('issues' in okClient).toBe(false);

    const okFactory = await prismaConfigSchema['~standard'].validate({
      createClient: () => fake.client,
    });
    expect('issues' in okFactory).toBe(false);

    const missingBoth = await prismaConfigSchema['~standard'].validate({});
    expect('issues' in missingBoth && missingBoth.issues !== undefined).toBe(true);

    const badTimeout = await prismaConfigSchema['~standard'].validate({
      client: fake.client,
      transactionTimeoutMs: 0,
    });
    expect('issues' in badTimeout && badTimeout.issues !== undefined).toBe(true);
  });

  it('manages PrismaClient lifecycle, ping, isolation-level transactions, and error normalization', async () => {
    const fake = createFakePrismaClient();
    const adapter = createPrismaAdapter<FakeAppPrismaClient>({
      name: 'primary-prisma',
      createClient: () => fake.client,
      transactionMaxWaitMs: 3000,
      transactionTimeoutMs: 8000,
    });

    expect(adapter.state).toBe('disconnected');
    expect(() => adapter.client).toThrow(DatabaseConnectionError);

    await adapter.connect();
    expect(adapter.state).toBe('connected');
    expect(await adapter.client.user.findMany()).toEqual([{ id: 1, email: 'alice@forgejs.dev' }]);

    const ping = await adapter.ping();
    expect(ping.ok).toBe(true);
    expect(ping.latencyMs).toBeGreaterThanOrEqual(0);

    const txRows = await runInTransaction(
      adapter,
      async (tx) => tx.user.findMany(),
      { isolationLevel: 'serializable' },
    );
    expect(txRows).toHaveLength(1);
    expect(fake.lastTxOptions).toEqual({
      isolationLevel: 'Serializable',
      maxWait: 3000,
      timeout: 8000,
    });

    await adapter.disconnect();
    expect(adapter.state).toBe('disconnected');
    expect(fake.events).toContain('disconnect');
  });

  it('maps failing $connect and P2002 transactions into normalized ForgeJS DatabaseErrors', async () => {
    const failingConnect = createFakePrismaClient({ failConnect: true });
    const badAdapter = createPrismaAdapter({ client: failingConnect.client });
    await expect(badAdapter.connect()).rejects.toThrow(DatabaseConnectionError);
    expect(badAdapter.state).toBe('error');

    const failingTx = createFakePrismaClient({ failTxCode: 'P2002' });
    const txAdapter = createPrismaAdapter({ client: failingTx.client });
    await txAdapter.connect();
    await expect(runInTransaction(txAdapter, async () => 'nope')).rejects.toThrow(
      DatabaseUniqueViolationError,
    );
    await txAdapter.disconnect();
  });

  it('integrates with ForgeJS plugin lifecycle, typed DI exports, and kernel.health checks', async () => {
    const fake = createFakePrismaClient();
    const tokens = createPrismaToken<FakeAppPrismaClient>('app');
    const plugin = createPrismaPlugin<FakeAppPrismaClient>({
      name: '@forge-fr/prisma-app',
      adapterToken: tokens.adapter,
      clientToken: tokens.client,
      healthCheckName: 'prisma-primary',
    });

    const harness = createPluginTestHarness({
      plugin,
      config: {
        createClient: () => fake.client,
      },
    });

    await harness.start();
    const adapter = harness.resolveExport(tokens.adapter);
    const prisma = harness.resolveExport(tokens.client);
    expect(adapter.state).toBe('connected');
    expect(prisma).toBe(fake.client);
    expect(await prisma.user.findMany()).toHaveLength(1);

    const health = await harness.health();
    expect(health.status).toBe('ok');
    expect(health.checks['prisma-primary']?.status).toBe('ok');

    await harness.dispose();
    expect(adapter.state).toBe('disconnected');
    expect(fake.events).toContain('disconnect');

    // Unhealthy ping propagates into kernel.health
    const unhealthyFake = createFakePrismaClient({ failPing: true });
    const unhealthyHarness = createPluginTestHarness({
      plugin,
      config: { client: unhealthyFake.client },
    });
    await unhealthyHarness.start();
    const badHealth = await unhealthyHarness.health();
    expect(badHealth.status).toBe('unhealthy');
    expect(badHealth.checks['prisma-primary']?.status).toBe('unhealthy');
    await unhealthyHarness.dispose();

    // Invalid config fails fast at configure stage
    const badConfigHarness = createPluginTestHarness({
      plugin,
      config: {},
    });
    await expect(badConfigHarness.configure()).rejects.toThrow(PluginConfigError);
    await badConfigHarness.dispose();
  });
});
