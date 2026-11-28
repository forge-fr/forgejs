import { describe, expect, it } from 'vitest';
import { integer, pgTable, text } from 'drizzle-orm/pg-core';
import { PluginConfigError, secret } from '@forge-fr/core';
import {
  DatabaseConnectionError,
  DatabaseForeignKeyViolationError,
  DatabaseSerializationError,
  DatabaseUniqueViolationError,
  defineRepository,
  runInTransaction,
  type PostgresClientLike,
} from '@forge-fr/database';
import { createPluginTestHarness } from '@forge-fr/testing';
import {
  createDrizzleAdapter,
  createDrizzlePostgresAdapter,
  createDrizzlePostgresPlugin,
  createDrizzleToken,
  createDrizzleUnitOfWork,
  drizzlePostgresConfigSchema,
  normalizeDrizzleError,
  type DrizzlePostgresClient,
} from '../src/index.js';

const usersTable = pgTable('users', {
  id: integer('id').primaryKey(),
  email: text('email').notNull(),
});

const appSchema = { users: usersTable };
type AppSchema = typeof appSchema;

function createFakeSql(): {
  client: PostgresClientLike;
  events: string[];
} {
  const events: string[] = [];
  const fn = async (strings: TemplateStringsArray): Promise<Record<string, unknown>[]> => {
    events.push(`query:${strings.join('?').trim()}`);
    return [{ ok: 1 }];
  };

  const client = Object.assign(fn, {
    options: {
      parsers: {} as Record<string, unknown>,
      serializers: {} as Record<string, unknown>,
    },
    unsafe: async (query: string) => {
      events.push(`unsafe:${query}`);
      return [];
    },
    begin: async <T>(
      a: string | ((tx: PostgresClientLike) => Promise<T>),
      b?: (tx: PostgresClientLike) => Promise<T>,
    ): Promise<T> => {
      const cb = typeof a === 'function' ? a : b!;
      events.push(`begin:${typeof a === 'string' ? a : 'default'}`);
      return cb(client);
    },
    end: async (opts?: { timeout?: number }) => {
      events.push(`end:${opts?.timeout ?? 'default'}`);
    },
  }) as unknown as PostgresClientLike;

  return { client, events };
}

describe('@forge-fr/drizzle Adapter & Plugin (M4.2)', () => {
  it('unwraps DrizzleQueryError cause chains into normalized DatabaseError subclasses with expose=false', () => {
    const pgUnique = Object.assign(new Error('duplicate key value violates unique constraint'), {
      code: '23505',
      constraint_name: 'users_email_key',
      table_name: 'users',
    });
    const drizzleWrapped = new Error('Failed query: insert into "users" ...', {
      cause: pgUnique,
    });

    const normalized = normalizeDrizzleError(drizzleWrapped);
    expect(normalized).toBeInstanceOf(DatabaseUniqueViolationError);
    expect(normalized.sqlState).toBe('23505');
    expect(normalized.constraint).toBe('users_email_key');
    expect(normalized.table).toBe('users');
    expect(normalized.expose).toBe(false);

    const fkWrapped = new Error('Failed query', {
      cause: Object.assign(new Error('fk violation'), { code: '23503' }),
    });
    expect(normalizeDrizzleError(fkWrapped)).toBeInstanceOf(DatabaseForeignKeyViolationError);

    const serialWrapped = new Error('Failed query', {
      cause: Object.assign(new Error('could not serialize access'), { code: '40001' }),
    });
    const serialErr = normalizeDrizzleError(serialWrapped);
    expect(serialErr).toBeInstanceOf(DatabaseSerializationError);
    expect(serialErr.retryable).toBe(true);
  });

  it('validates Drizzle PostgreSQL config via Standard Schema v1', async () => {
    const valid = await drizzlePostgresConfigSchema['~standard'].validate({
      url: secret('postgres://forge:pass@localhost:5432/app'),
      schema: appSchema,
      casing: 'snake_case',
      logger: false,
      max: 8,
    });
    expect('issues' in valid).toBe(false);

    const badUrl = await drizzlePostgresConfigSchema['~standard'].validate({
      url: 'sqlite://local.db',
    });
    expect('issues' in badUrl && badUrl.issues !== undefined).toBe(true);

    const badCasing = await drizzlePostgresConfigSchema['~standard'].validate({
      url: 'postgres://localhost:5432/app',
      casing: 'kebab-case',
    });
    expect('issues' in badCasing && badCasing.issues !== undefined).toBe(true);
  });

  it('creates a real typed drizzle-orm PostgresJsDatabase preserving native schema & query builder APIs', async () => {
    const fakeSql = createFakeSql();
    const adapter = createDrizzlePostgresAdapter<AppSchema>({
      name: 'primary-drizzle',
      url: secret('postgres://app:super-secret@localhost:5432/forge'),
      schema: appSchema,
      driverFactory: () => fakeSql.client,
    });

    expect(adapter.state).toBe('disconnected');
    expect(() => adapter.client).toThrow(DatabaseConnectionError);

    await adapter.connect();
    expect(adapter.state).toBe('connected');

    const db = adapter.client;
    const compiled = db.select().from(usersTable).toSQL();
    expect(compiled.sql).toContain('users');
    expect(db.query.users).toBeDefined();

    const ping = await adapter.ping();
    expect(ping.ok).toBe(true);

    await adapter.disconnect();
    expect(adapter.state).toBe('disconnected');
    expect(fakeSql.events).toContain('end:5');
  });

  it('maps transaction options and normalizes Drizzle errors inside runInTransaction', async () => {
    const fakeSql = createFakeSql();
    let capturedTxConfig: unknown;
    let shouldFailUnique = false;

    const fakeDb = {
      transaction: async <T>(
        fn: (tx: unknown) => Promise<T>,
        config?: unknown,
      ): Promise<T> => {
        capturedTxConfig = config;
        if (shouldFailUnique) {
          throw new Error('Failed query', {
            cause: Object.assign(new Error('duplicate key'), {
              code: '23505',
              constraint_name: 'users_email_unique',
            }),
          });
        }
        return fn({ kind: 'drizzle-tx' });
      },
    } as unknown as DrizzlePostgresClient<AppSchema>;

    const adapter = createDrizzlePostgresAdapter<AppSchema>({
      url: 'postgres://localhost:5432/forge',
      schema: appSchema,
      driverFactory: () => fakeSql.client,
      drizzleFactory: () => fakeDb,
    });

    await adapter.connect();
    const result = await runInTransaction(
      adapter,
      async (tx) => tx,
      { isolationLevel: 'serializable', readOnly: true, deferrable: true },
    );
    expect(result).toEqual({ kind: 'drizzle-tx' });
    expect(capturedTxConfig).toEqual({
      isolationLevel: 'serializable',
      accessMode: 'read only',
      deferrable: true,
    });

    shouldFailUnique = true;
    await expect(runInTransaction(adapter, async () => 'nope')).rejects.toThrow(
      DatabaseUniqueViolationError,
    );

    await adapter.disconnect();
  });

  it('integrates with ForgeJS plugin lifecycle, DI token exports, and kernel.health checks', async () => {
    const fakeSql = createFakeSql();
    const tokens = createDrizzleToken<DrizzlePostgresClient<AppSchema>>('app');
    const plugin = createDrizzlePostgresPlugin<AppSchema>({
      name: '@forge-fr/drizzle-app',
      adapterToken: tokens.adapter,
      dbToken: tokens.db,
      healthCheckName: 'drizzle-primary',
    });

    const harness = createPluginTestHarness({
      plugin,
      config: {
        url: secret('postgres://forge:secret-pass@localhost:5432/app'),
        schema: appSchema,
        driverFactory: () => fakeSql.client,
      },
    });

    await harness.start();
    const resolvedAdapter = harness.resolveExport(tokens.adapter);
    const resolvedDb = harness.resolveExport(tokens.db);
    expect(resolvedAdapter.state).toBe('connected');
    expect(resolvedDb.select().from(usersTable).toSQL().sql).toContain('users');

    const health = await harness.health();
    expect(health.status).toBe('ok');
    expect(health.checks['drizzle-primary']?.status).toBe('ok');

    await harness.dispose();
    expect(resolvedAdapter.state).toBe('disconnected');

    const badHarness = createPluginTestHarness({
      plugin,
      config: { url: 'invalid-url' },
    });
    await expect(badHarness.configure()).rejects.toThrow(PluginConfigError);
    await badHarness.dispose();
  });

  it('supports generic createDrizzleAdapter for custom Drizzle dialects and redacts secrets on real postgres failure', async () => {
    const events: string[] = [];
    const customDb = { dialect: 'sqlite', execute: () => [{ ok: 1 }] };
    const custom = createDrizzleAdapter({
      name: 'sqlite-drizzle',
      driver: 'drizzle-sqlite',
      connect: async () => {
        events.push('connect');
        return customDb;
      },
      disconnect: async () => {
        events.push('disconnect');
      },
      ping: async () => {
        events.push('ping');
      },
    });

    await custom.connect();
    expect(custom.client).toBe(customDb);
    const ping = await custom.ping();
    expect(ping.ok).toBe(true);
    await custom.disconnect();
    expect(events).toEqual(['connect', 'ping', 'disconnect']);

    const unreachable = createDrizzlePostgresAdapter({
      url: secret('postgres://forge:drizzle-secret-pw-777@127.0.0.1:1/missing'),
      connectTimeoutSeconds: 1,
      max: 1,
    });
    let caught: unknown;
    try {
      await unreachable.connect();
    } catch (err: unknown) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(DatabaseConnectionError);
    expect((caught as DatabaseConnectionError).message).not.toContain('drizzle-secret-pw-777');
    expect(unreachable.state).toBe('error');
  });

  it('supports createDrizzleUnitOfWork, defineRepository, and exports tokens.unitOfWork from createDrizzlePostgresPlugin', async () => {
    const fakeSql = createFakeSql();
    const tokens = createDrizzleToken<DrizzlePostgresClient<AppSchema>>('uow-app');
    const plugin = createDrizzlePostgresPlugin<AppSchema>({
      name: '@forge-fr/drizzle-uow-app',
      adapterToken: tokens.adapter,
      dbToken: tokens.db,
      unitOfWorkToken: tokens.unitOfWork,
    });

    const harness = createPluginTestHarness({
      plugin,
      config: {
        url: secret('postgres://forge:pass@localhost:5432/app'),
        schema: appSchema,
        driverFactory: () => fakeSql.client,
      },
    });

    await harness.start();
    const uow = harness.resolveExport(tokens.unitOfWork);
    const directUow = createDrizzleUnitOfWork(harness.resolveExport(tokens.adapter));

    const UsersDrizzleRepo = defineRepository((db: { select: DrizzlePostgresClient<AppSchema>['select'] }) => ({
      compileSelectAll(): string {
        return db.select().from(usersTable).toSQL().sql;
      },
    }));

    const events: string[] = [];
    const sqlText = await uow.run(async (ctx) => {
      ctx.afterCommit(() => {
        events.push('committed');
      });
      return ctx.repository(UsersDrizzleRepo).compileSelectAll();
    });

    expect(sqlText).toContain('users');
    expect(events).toEqual(['committed']);
    expect(directUow.repository(UsersDrizzleRepo).compileSelectAll()).toContain('users');

    await harness.dispose();
  });
});
