import { describe, expect, it } from 'vitest';
import { PluginConfigError, secret } from '@forge-fr/core';
import { createPluginTestHarness } from '@forge-fr/testing';
import {
  DatabaseConnectionError,
  DatabaseUniqueViolationError,
  createDatabaseToken,
  createPostgresAdapter,
  createPostgresPlugin,
  postgresConfigSchema,
  runInTransaction,
  type PostgresClientLike,
} from '../src/index.js';

function createFakePostgresClient(options?: {
  failPing?: boolean;
  failTxWithCode?: string;
}): {
  client: PostgresClientLike;
  events: string[];
  lastBeginOptions: string | undefined;
} {
  const events: string[] = [];
  let lastBeginOptions: string | undefined;

  const queryFn = async (strings: TemplateStringsArray): Promise<Record<string, unknown>[]> => {
    const sqlText = strings.join('?').trim();
    events.push(`query:${sqlText}`);
    if (options?.failPing && sqlText.includes('SELECT 1')) {
      throw Object.assign(new Error('server closed the connection unexpectedly'), { code: '08006' });
    }
    return [{ ok: 1 }];
  };

  const client = Object.assign(queryFn, {
    begin: async <T>(
      optionsOrFn: string | ((tx: PostgresClientLike) => Promise<T>),
      maybeFn?: (tx: PostgresClientLike) => Promise<T>,
    ): Promise<T> => {
      const fn = typeof optionsOrFn === 'function' ? optionsOrFn : maybeFn!;
      if (typeof optionsOrFn === 'string') {
        lastBeginOptions = optionsOrFn;
      }
      events.push(`begin:${typeof optionsOrFn === 'string' ? optionsOrFn : 'default'}`);
      if (options?.failTxWithCode) {
        throw Object.assign(new Error('constraint violated'), {
          code: options.failTxWithCode,
          constraint_name: 'users_email_key',
        });
      }
      return fn(client);
    },
    end: async (opts?: { timeout?: number }) => {
      events.push(`end:${opts?.timeout ?? 'default'}`);
    },
  }) as unknown as PostgresClientLike;

  return {
    client,
    events,
    get lastBeginOptions() {
      return lastBeginOptions;
    },
  };
}

describe('@forge-fr/database PostgreSQL Adapter & ForgeJS Plugin (M4.1)', () => {
  it('validates PostgreSQL adapter configuration via Standard Schema v1', async () => {
    const ok = await postgresConfigSchema['~standard'].validate({
      url: secret('postgres://user:pass@localhost:5432/app'),
      max: 10,
      connectTimeoutSeconds: 5,
    });
    expect('issues' in ok).toBe(false);

    const badScheme = await postgresConfigSchema['~standard'].validate({
      url: 'mysql://localhost:3306/app',
    });
    expect('issues' in badScheme && badScheme.issues !== undefined).toBe(true);

    const badPool = await postgresConfigSchema['~standard'].validate({
      url: 'postgres://localhost:5432/app',
      max: 0,
    });
    expect('issues' in badPool && badPool.issues !== undefined).toBe(true);
  });

  it('manages connect/ping/transaction/disconnect lifecycle and preserves native client access', async () => {
    const fake = createFakePostgresClient();
    const adapter = createPostgresAdapter({
      url: secret('postgres://app:super-secret@localhost:5432/forge'),
      max: 5,
      driverFactory: () => fake.client,
    });

    expect(adapter.state).toBe('disconnected');
    expect(() => adapter.client).toThrow(DatabaseConnectionError);

    await adapter.connect();
    expect(adapter.state).toBe('connected');
    expect(adapter.client).toBe(fake.client);

    const ping = await adapter.ping();
    expect(ping.ok).toBe(true);
    expect(ping.latencyMs).toBeGreaterThanOrEqual(0);

    const txResult = await runInTransaction(
      adapter,
      async (tx) => {
        const rows = await tx`SELECT 1 AS ok`;
        return rows.length;
      },
      { isolationLevel: 'serializable', readOnly: true, deferrable: true },
    );
    expect(txResult).toBe(1);
    expect(fake.lastBeginOptions).toBe('ISOLATION LEVEL SERIALIZABLE READ ONLY DEFERRABLE');

    await adapter.disconnect();
    expect(adapter.state).toBe('disconnected');
    expect(fake.events).toContain('end:5');
  });

  it('normalizes PostgreSQL SQLSTATE errors inside transactions', async () => {
    const fake = createFakePostgresClient({ failTxWithCode: '23505' });
    const adapter = createPostgresAdapter({
      url: 'postgres://localhost:5432/forge',
      driverFactory: () => fake.client,
    });
    await adapter.connect();
    await expect(
      runInTransaction(adapter, async () => 'never'),
    ).rejects.toThrow(DatabaseUniqueViolationError);
    await adapter.disconnect();
  });

  it('integrates with ForgeJS plugin lifecycle, DI token exports, and kernel.health checks', async () => {
    const fake = createFakePostgresClient();
    const tokens = createDatabaseToken<PostgresClientLike>('primary');
    const plugin = createPostgresPlugin({
      name: '@forge-fr/database-primary',
      adapterToken: tokens.adapter,
      clientToken: tokens.client,
      healthCheckName: 'postgres-primary',
    });

    const harness = createPluginTestHarness({
      plugin,
      config: {
        url: secret('postgres://forge:hidden-password@localhost:5432/app'),
        driverFactory: () => fake.client,
      },
    });

    await harness.start();
    const resolvedAdapter = harness.resolveExport(tokens.adapter);
    const resolvedClient = harness.resolveExport(tokens.client);
    expect(resolvedAdapter.state).toBe('connected');
    expect(resolvedClient).toBe(fake.client);

    const report = await harness.health();
    expect(report.status).toBe('ok');
    expect(report.checks['postgres-primary']?.status).toBe('ok');

    await harness.dispose();
    expect(resolvedAdapter.state).toBe('disconnected');

    // Invalid config rejected fail-fast at configure stage via Standard Schema v1
    const badHarness = createPluginTestHarness({
      plugin,
      config: { url: 'invalid-url' },
    });
    await expect(badHarness.configure()).rejects.toThrow(PluginConfigError);
    await badHarness.dispose();
  });

  it('fails fast with DatabaseConnectionError and redacted credentials using the real postgres-js driver on an unreachable port', async () => {
    const adapter = createPostgresAdapter({
      url: secret('postgres://forge:top-secret-pw-999@127.0.0.1:1/nonexistent'),
      connectTimeoutSeconds: 1,
      max: 1,
    });

    let caught: unknown;
    try {
      await adapter.connect();
    } catch (err: unknown) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(DatabaseConnectionError);
    const err = caught as DatabaseConnectionError;
    expect(err.message).not.toContain('top-secret-pw-999');
    expect(JSON.stringify(err.toPublicJSON({ production: true }))).not.toContain(
      'top-secret-pw-999',
    );
    expect(adapter.state).toBe('error');
  });
});
