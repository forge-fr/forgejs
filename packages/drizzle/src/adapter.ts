import type { DrizzleConfig } from 'drizzle-orm';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import {
  createToken,
  type ForgePlugin,
  type InjectionToken,
  type StandardSchemaIssueLike,
  type StandardSchemaLike,
} from '@forge-fr/core';
import {
  DatabaseConnectionError,
  DatabaseError,
  createDatabasePlugin,
  createPostgresAdapter,
  postgresConfigSchema,
  type DatabaseAdapter,
  type DatabaseConnectionState,
  type DatabasePingResult,
  type PostgresAdapterOptions,
  type PostgresClientLike,
  type TransactionIsolationLevel,
  type TransactionOptions,
} from '@forge-fr/database';
import { normalizeDrizzleError } from './errors.js';

export type DrizzleCasing = 'snake_case' | 'camelCase';

export type DrizzlePostgresClient<
  TSchema extends Record<string, unknown> = Record<string, never>,
> = PostgresJsDatabase<TSchema>;

export type DrizzlePostgresTx<
  TSchema extends Record<string, unknown> = Record<string, never>,
> = Parameters<Parameters<PostgresJsDatabase<TSchema>['transaction']>[0]>[0];

export type InferDrizzleTx<TDb> =
  TDb extends PostgresJsDatabase<infer TSchema> ? DrizzlePostgresTx<TSchema> : TDb;

export interface DrizzleTokens<TDb = DrizzlePostgresClient, TTx = InferDrizzleTx<TDb>> {
  readonly adapter: InjectionToken<DatabaseAdapter<TDb, TTx>>;
  readonly db: InjectionToken<TDb>;
}

export function createDrizzleToken<TDb = DrizzlePostgresClient, TTx = InferDrizzleTx<TDb>>(
  name = 'default',
): DrizzleTokens<TDb, TTx> {
  return Object.freeze({
    adapter: createToken<DatabaseAdapter<TDb, TTx>>(`DrizzleAdapter:${name}`),
    db: createToken<TDb>(`DrizzleDb:${name}`),
  });
}

export const DefaultDrizzleTokens = createDrizzleToken<DrizzlePostgresClient>('default');

export interface DrizzlePostgresConfig<
  TSchema extends Record<string, unknown> = Record<string, never>,
> extends PostgresAdapterOptions {
  readonly schema?: TSchema;
  readonly logger?: DrizzleConfig<TSchema>['logger'];
  readonly casing?: DrizzleCasing;
  readonly drizzleFactory?: (
    sql: PostgresClientLike,
    config: DrizzlePostgresConfig<TSchema>,
  ) => DrizzlePostgresClient<TSchema>;
}

export interface DrizzlePostgresAdapter<
  TSchema extends Record<string, unknown> = Record<string, never>,
> extends DatabaseAdapter<DrizzlePostgresClient<TSchema>, DrizzlePostgresTx<TSchema>> {
  readonly rawAdapter: DatabaseAdapter<PostgresClientLike, PostgresClientLike>;
}

export interface DrizzlePostgresPluginOptions<
  TSchema extends Record<string, unknown> = Record<string, never>,
> {
  readonly name?: string;
  readonly version?: string;
  readonly forgeVersion?: string;
  readonly adapterToken?: InjectionToken<
    DatabaseAdapter<DrizzlePostgresClient<TSchema>, DrizzlePostgresTx<TSchema>>
  >;
  readonly dbToken?: InjectionToken<DrizzlePostgresClient<TSchema>>;
  readonly healthCheckName?: string;
}

export interface GenericDrizzleAdapterOptions<TDb, TTx = TDb> {
  readonly name?: string;
  readonly driver?: string;
  readonly connect: () => Promise<TDb>;
  readonly disconnect: (db: TDb) => Promise<void>;
  readonly ping: (db: TDb) => Promise<void>;
  readonly transaction?: <TResult>(
    db: TDb,
    fn: (tx: TTx) => Promise<TResult>,
    options?: TransactionOptions,
  ) => Promise<TResult>;
}

const VALID_CASINGS = new Set<string>(['snake_case', 'camelCase']);

const DRIZZLE_ISOLATION_MAP: Readonly<
  Record<
    TransactionIsolationLevel,
    'read uncommitted' | 'read committed' | 'repeatable read' | 'serializable'
  >
> = Object.freeze({
  read_uncommitted: 'read uncommitted',
  read_committed: 'read committed',
  repeatable_read: 'repeatable read',
  serializable: 'serializable',
});

export const drizzlePostgresConfigSchema: StandardSchemaLike<
  DrizzlePostgresConfig<Record<string, unknown>>,
  DrizzlePostgresConfig<Record<string, unknown>>
> = Object.freeze({
  '~standard': Object.freeze({
    version: 1 as const,
    vendor: 'forgejs',
    async validate(value: unknown) {
      const baseResult = await postgresConfigSchema['~standard'].validate(value);
      const issues: StandardSchemaIssueLike[] =
        'issues' in baseResult && baseResult.issues !== undefined ? [...baseResult.issues] : [];

      if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
        const cfg = value as Record<string, unknown>;

        if (cfg['casing'] !== undefined) {
          if (typeof cfg['casing'] !== 'string' || !VALID_CASINGS.has(cfg['casing'])) {
            issues.push({
              path: ['casing'],
              message: 'casing must be either "snake_case" or "camelCase"',
            });
          }
        }

        if (cfg['schema'] !== undefined) {
          if (typeof cfg['schema'] !== 'object' || cfg['schema'] === null || Array.isArray(cfg['schema'])) {
            issues.push({
              path: ['schema'],
              message: 'schema must be a plain Drizzle schema object',
            });
          }
        }

        if (cfg['logger'] !== undefined) {
          const loggerVal = cfg['logger'];
          const isValidLogger =
            typeof loggerVal === 'boolean' ||
            (typeof loggerVal === 'object' &&
              loggerVal !== null &&
              'logQuery' in loggerVal &&
              typeof (loggerVal as { logQuery?: unknown }).logQuery === 'function');
          if (!isValidLogger) {
            issues.push({
              path: ['logger'],
              message: 'logger must be a boolean or a Drizzle Logger object with logQuery()',
            });
          }
        }

        if (cfg['drizzleFactory'] !== undefined && typeof cfg['drizzleFactory'] !== 'function') {
          issues.push({
            path: ['drizzleFactory'],
            message: 'drizzleFactory must be a function',
          });
        }
      }

      if (issues.length > 0) {
        return { issues };
      }

      return { value: value as DrizzlePostgresConfig<Record<string, unknown>> };
    },
  }),
});

export function createDrizzleAdapter<TDb, TTx = TDb>(
  options: GenericDrizzleAdapterOptions<TDb, TTx>,
): DatabaseAdapter<TDb, TTx> {
  const adapterName = options.name ?? 'drizzle';
  const driverName = options.driver ?? 'drizzle';
  let currentState: DatabaseConnectionState = 'disconnected';
  let activeDb: TDb | null = null;

  const adapter: DatabaseAdapter<TDb, TTx> = {
    name: adapterName,
    driver: driverName,

    get state(): DatabaseConnectionState {
      return currentState;
    },

    get client(): TDb {
      if (activeDb === null || currentState !== 'connected') {
        throw new DatabaseConnectionError(
          `Drizzle adapter "${adapterName}" is not connected (current state: "${currentState}")`,
        );
      }
      return activeDb;
    },

    async connect(): Promise<void> {
      if (currentState === 'connected' && activeDb !== null) {
        return;
      }
      currentState = 'connecting';
      try {
        activeDb = await options.connect();
        currentState = 'connected';
      } catch (err: unknown) {
        currentState = 'error';
        activeDb = null;
        const normalized = normalizeDrizzleError(err);
        if (normalized instanceof DatabaseConnectionError) {
          throw normalized;
        }
        throw new DatabaseConnectionError(
          `Failed to connect Drizzle adapter "${adapterName}": ${normalized.message}`,
          { cause: err },
        );
      }
    },

    async disconnect(): Promise<void> {
      if (activeDb === null || currentState === 'disconnected') {
        currentState = 'disconnected';
        activeDb = null;
        return;
      }
      currentState = 'disconnecting';
      const dbToClose = activeDb;
      activeDb = null;
      try {
        await options.disconnect(dbToClose);
        currentState = 'disconnected';
      } catch (err: unknown) {
        currentState = 'error';
        throw normalizeDrizzleError(err);
      }
    },

    async ping(): Promise<DatabasePingResult> {
      if (activeDb === null || currentState !== 'connected') {
        throw new DatabaseConnectionError(
          `Cannot ping Drizzle adapter "${adapterName}" while "${currentState}"`,
        );
      }
      const start = Date.now();
      try {
        await options.ping(activeDb);
        return Object.freeze({
          ok: true as const,
          latencyMs: Math.max(0, Date.now() - start),
        });
      } catch (err: unknown) {
        throw normalizeDrizzleError(err);
      }
    },

    ...(options.transaction !== undefined
      ? {
          async transaction<TResult>(
            fn: (tx: TTx) => Promise<TResult>,
            txOptions?: TransactionOptions,
          ): Promise<TResult> {
            if (activeDb === null || currentState !== 'connected') {
              throw new DatabaseConnectionError(
                `Cannot start transaction on Drizzle adapter "${adapterName}" while "${currentState}"`,
              );
            }
            try {
              return await options.transaction!(activeDb, fn, txOptions);
            } catch (err: unknown) {
              throw normalizeDrizzleError(err);
            }
          },
        }
      : {}),
  };

  return adapter;
}

function mapDrizzleTxConfig(txOptions?: TransactionOptions): {
  isolationLevel?: 'read uncommitted' | 'read committed' | 'repeatable read' | 'serializable';
  accessMode?: 'read only' | 'read write';
  deferrable?: boolean;
} | undefined {
  if (txOptions === undefined) {
    return undefined;
  }

  const config: {
    isolationLevel?: 'read uncommitted' | 'read committed' | 'repeatable read' | 'serializable';
    accessMode?: 'read only' | 'read write';
    deferrable?: boolean;
  } = {};

  if (txOptions.isolationLevel !== undefined) {
    const mapped = DRIZZLE_ISOLATION_MAP[txOptions.isolationLevel];
    if (mapped === undefined) {
      throw new DatabaseError('Unsupported transaction isolation level', {
        code: 'DB_INVALID_TRANSACTION_OPTION',
        statusCode: 400,
        expose: false,
      });
    }
    config.isolationLevel = mapped;
  }

  if (txOptions.readOnly === true) {
    config.accessMode = 'read only';
  } else if (txOptions.readOnly === false) {
    config.accessMode = 'read write';
  }

  if (txOptions.deferrable !== undefined) {
    config.deferrable = txOptions.deferrable;
  }

  return Object.keys(config).length > 0 ? config : undefined;
}

export function createDrizzlePostgresAdapter<
  TSchema extends Record<string, unknown> = Record<string, never>,
>(config: DrizzlePostgresConfig<TSchema>): DrizzlePostgresAdapter<TSchema> {
  const adapterName = config.name ?? 'drizzle-postgres';
  const rawAdapter = createPostgresAdapter({
    ...config,
    name: adapterName,
  });

  let activeDb: DrizzlePostgresClient<TSchema> | null = null;

  return {
    name: adapterName,
    driver: 'drizzle-postgres',
    rawAdapter,

    get state(): DatabaseConnectionState {
      return rawAdapter.state;
    },

    get client(): DrizzlePostgresClient<TSchema> {
      if (activeDb === null || rawAdapter.state !== 'connected') {
        throw new DatabaseConnectionError(
          `Drizzle PostgreSQL adapter "${adapterName}" is not connected (current state: "${rawAdapter.state}")`,
        );
      }
      return activeDb;
    },

    async connect(): Promise<void> {
      if (rawAdapter.state === 'connected' && activeDb !== null) {
        return;
      }

      await rawAdapter.connect();

      const drizzleOpts: DrizzleConfig<TSchema> = {
        ...(config.schema !== undefined ? { schema: config.schema } : {}),
        ...(config.logger !== undefined ? { logger: config.logger } : {}),
        ...(config.casing !== undefined ? { casing: config.casing } : {}),
      };

      activeDb = config.drizzleFactory
        ? config.drizzleFactory(rawAdapter.client, config)
        : drizzle<TSchema>({
            client: rawAdapter.client as never,
            ...drizzleOpts,
          });
    },

    async disconnect(): Promise<void> {
      activeDb = null;
      await rawAdapter.disconnect();
    },

    async ping(): Promise<DatabasePingResult> {
      return rawAdapter.ping();
    },

    async transaction<TResult>(
      fn: (tx: DrizzlePostgresTx<TSchema>) => Promise<TResult>,
      txOptions?: TransactionOptions,
    ): Promise<TResult> {
      if (activeDb === null || rawAdapter.state !== 'connected') {
        throw new DatabaseConnectionError(
          `Cannot start transaction on Drizzle PostgreSQL adapter "${adapterName}" while "${rawAdapter.state}"`,
        );
      }

      const mapped = mapDrizzleTxConfig(txOptions);

      try {
        if (mapped !== undefined) {
          return await activeDb.transaction((tx) => fn(tx), mapped);
        }
        return await activeDb.transaction((tx) => fn(tx));
      } catch (err: unknown) {
        throw normalizeDrizzleError(err);
      }
    },
  };
}

export function createDrizzlePostgresPlugin<
  TSchema extends Record<string, unknown> = Record<string, never>,
>(
  options: DrizzlePostgresPluginOptions<TSchema> = {},
): ForgePlugin<DrizzlePostgresConfig<TSchema>, DrizzlePostgresConfig<TSchema>> {
  return createDatabasePlugin<
    DrizzlePostgresClient<TSchema>,
    DrizzlePostgresTx<TSchema>,
    DrizzlePostgresConfig<TSchema>,
    DrizzlePostgresConfig<TSchema>
  >({
    name: options.name ?? '@forge-fr/drizzle',
    ...(options.version !== undefined ? { version: options.version } : {}),
    ...(options.forgeVersion !== undefined ? { forgeVersion: options.forgeVersion } : {}),
    adapterToken: (options.adapterToken ?? DefaultDrizzleTokens.adapter) as InjectionToken<
      DatabaseAdapter<DrizzlePostgresClient<TSchema>, DrizzlePostgresTx<TSchema>>
    >,
    clientToken: (options.dbToken ?? DefaultDrizzleTokens.db) as InjectionToken<
      DrizzlePostgresClient<TSchema>
    >,
    healthCheckName: options.healthCheckName ?? options.name ?? 'drizzle-postgres',
    configSchema: drizzlePostgresConfigSchema as unknown as StandardSchemaLike<
      DrizzlePostgresConfig<TSchema>,
      DrizzlePostgresConfig<TSchema>
    >,
    createAdapter: (config) => createDrizzlePostgresAdapter<TSchema>(config),
  });
}
