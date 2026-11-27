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
  type DatabaseAdapter,
  type DatabaseConnectionState,
  type DatabasePingResult,
  type TransactionIsolationLevel,
  type TransactionOptions,
} from '@forge-fr/database';
import { normalizePrismaError } from './errors.js';

export type PrismaIsolationLevel =
  | 'ReadUncommitted'
  | 'ReadCommitted'
  | 'RepeatableRead'
  | 'Serializable';

export interface PrismaTransactionOptions {
  readonly isolationLevel?: PrismaIsolationLevel;
  readonly maxWait?: number;
  readonly timeout?: number;
}

/**
 * Structural contract compatible with any generated PrismaClient (v5, v6, v7+,
 * including Prisma driver adapters) without hiding generated model delegates.
 */
export interface PrismaClientLike {
  $connect(): Promise<void>;
  $disconnect(): Promise<void>;
  $queryRaw?<T = unknown>(query: TemplateStringsArray, ...values: readonly unknown[]): Promise<T>;
  $queryRawUnsafe?<T = unknown>(query: string, ...values: readonly unknown[]): Promise<T>;
  $transaction?<TResult>(
    fn: (tx: never) => Promise<TResult>,
    options?: PrismaTransactionOptions,
  ): Promise<TResult>;
}

export interface PrismaTokens<
  TClient extends PrismaClientLike = PrismaClientLike,
  TTxClient = TClient,
> {
  readonly adapter: InjectionToken<DatabaseAdapter<TClient, TTxClient>>;
  readonly client: InjectionToken<TClient>;
}

export function createPrismaToken<
  TClient extends PrismaClientLike = PrismaClientLike,
  TTxClient = TClient,
>(name = 'default'): PrismaTokens<TClient, TTxClient> {
  return Object.freeze({
    adapter: createToken<DatabaseAdapter<TClient, TTxClient>>(`PrismaAdapter:${name}`),
    client: createToken<TClient>(`PrismaClient:${name}`),
  });
}

export const DefaultPrismaTokens = createPrismaToken<PrismaClientLike>('default');

export interface PrismaAdapterOptions<TClient extends PrismaClientLike = PrismaClientLike> {
  readonly name?: string;
  readonly client?: TClient;
  readonly createClient?: () => TClient | Promise<TClient>;
  readonly ping?: (client: TClient) => Promise<void>;
  readonly transactionMaxWaitMs?: number;
  readonly transactionTimeoutMs?: number;
}

export interface PrismaPluginOptions<
  TClient extends PrismaClientLike = PrismaClientLike,
  TTxClient = TClient,
> {
  readonly name?: string;
  readonly version?: string;
  readonly forgeVersion?: string;
  readonly adapterToken?: InjectionToken<DatabaseAdapter<TClient, TTxClient>>;
  readonly clientToken?: InjectionToken<TClient>;
  readonly healthCheckName?: string;
}

const PRISMA_ISOLATION_MAP: Readonly<Record<TransactionIsolationLevel, PrismaIsolationLevel>> =
  Object.freeze({
    read_uncommitted: 'ReadUncommitted',
    read_committed: 'ReadCommitted',
    repeatable_read: 'RepeatableRead',
    serializable: 'Serializable',
  });

function isPrismaClientLike(value: unknown): value is PrismaClientLike {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const obj = value as Record<string, unknown>;
  return typeof obj['$connect'] === 'function' && typeof obj['$disconnect'] === 'function';
}

export const prismaConfigSchema: StandardSchemaLike<
  PrismaAdapterOptions<PrismaClientLike>,
  PrismaAdapterOptions<PrismaClientLike>
> = Object.freeze({
  '~standard': Object.freeze({
    version: 1 as const,
    vendor: 'forgejs',
    validate(value: unknown) {
      const issues: StandardSchemaIssueLike[] = [];

      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return {
          issues: [{ message: 'Prisma configuration must be an object' }],
        };
      }

      const cfg = value as Record<string, unknown>;
      const hasClient = cfg['client'] !== undefined;
      const hasFactory = cfg['createClient'] !== undefined;

      if (!hasClient && !hasFactory) {
        issues.push({
          path: ['client'],
          message: 'Either "client" (PrismaClient instance) or "createClient" factory is required',
        });
      }

      if (hasClient && !isPrismaClientLike(cfg['client'])) {
        issues.push({
          path: ['client'],
          message: 'client must implement $connect() and $disconnect()',
        });
      }

      if (hasFactory && typeof cfg['createClient'] !== 'function') {
        issues.push({
          path: ['createClient'],
          message: 'createClient must be a function returning a PrismaClient instance',
        });
      }

      if (cfg['name'] !== undefined) {
        if (typeof cfg['name'] !== 'string' || cfg['name'].trim().length === 0) {
          issues.push({
            path: ['name'],
            message: 'Adapter name must be a non-empty string',
          });
        }
      }

      if (cfg['ping'] !== undefined && typeof cfg['ping'] !== 'function') {
        issues.push({
          path: ['ping'],
          message: 'ping must be a function',
        });
      }

      for (const field of ['transactionMaxWaitMs', 'transactionTimeoutMs'] as const) {
        const val = cfg[field];
        if (val !== undefined) {
          if (typeof val !== 'number' || !Number.isFinite(val) || val <= 0) {
            issues.push({
              path: [field],
              message: `${field} must be a positive finite number`,
            });
          }
        }
      }

      if (issues.length > 0) {
        return { issues };
      }

      return { value: cfg as unknown as PrismaAdapterOptions<PrismaClientLike> };
    },
  }),
});

export function createPrismaAdapter<
  TClient extends PrismaClientLike = PrismaClientLike,
  TTxClient = TClient,
>(options: PrismaAdapterOptions<TClient>): DatabaseAdapter<TClient, TTxClient> {
  const adapterName = options.name ?? 'prisma';
  let currentState: DatabaseConnectionState = 'disconnected';
  let activeClient: TClient | null = null;

  return {
    name: adapterName,
    driver: 'prisma',

    get state(): DatabaseConnectionState {
      return currentState;
    },

    get client(): TClient {
      if (activeClient === null || currentState !== 'connected') {
        throw new DatabaseConnectionError(
          `Prisma adapter "${adapterName}" is not connected (current state: "${currentState}")`,
        );
      }
      return activeClient;
    },

    async connect(): Promise<void> {
      if (currentState === 'connected' && activeClient !== null) {
        return;
      }

      currentState = 'connecting';
      let candidate: TClient | null = null;

      try {
        if (options.client !== undefined) {
          candidate = options.client;
        } else if (options.createClient !== undefined) {
          candidate = await options.createClient();
        } else {
          throw new DatabaseConnectionError(
            `Prisma adapter "${adapterName}" requires either "client" or "createClient"`,
            { retryable: false },
          );
        }

        if (!isPrismaClientLike(candidate)) {
          throw new DatabaseConnectionError(
            `Prisma adapter "${adapterName}" received an invalid PrismaClient instance`,
            { retryable: false },
          );
        }

        await candidate.$connect();
        activeClient = candidate;
        currentState = 'connected';
      } catch (err: unknown) {
        currentState = 'error';
        activeClient = null;
        const normalized = normalizePrismaError(err);
        if (normalized instanceof DatabaseConnectionError) {
          throw normalized;
        }
        throw new DatabaseConnectionError(
          `Failed to connect Prisma adapter "${adapterName}": ${normalized.message}`,
          {
            cause: err,
            ...(normalized.sqlState !== undefined ? { sqlState: normalized.sqlState } : {}),
            ...(normalized.driverCode !== undefined ? { driverCode: normalized.driverCode } : {}),
          },
        );
      }
    },

    async disconnect(): Promise<void> {
      if (activeClient === null || currentState === 'disconnected') {
        currentState = 'disconnected';
        activeClient = null;
        return;
      }

      currentState = 'disconnecting';
      const clientToClose = activeClient;
      activeClient = null;

      try {
        await clientToClose.$disconnect();
        currentState = 'disconnected';
      } catch (err: unknown) {
        currentState = 'error';
        throw normalizePrismaError(err);
      }
    },

    async ping(): Promise<DatabasePingResult> {
      if (activeClient === null || currentState !== 'connected') {
        throw new DatabaseConnectionError(
          `Cannot ping Prisma adapter "${adapterName}" while "${currentState}"`,
        );
      }

      const start = Date.now();
      try {
        if (options.ping !== undefined) {
          await options.ping(activeClient);
        } else if (typeof activeClient.$queryRaw === 'function') {
          await activeClient.$queryRaw`SELECT 1`;
        } else if (typeof activeClient.$queryRawUnsafe === 'function') {
          await activeClient.$queryRawUnsafe('SELECT 1');
        } else {
          throw new DatabaseError(
            `Prisma client for "${adapterName}" does not expose $queryRaw/$queryRawUnsafe; provide a custom ping() function`,
            { code: 'DB_PING_UNSUPPORTED', statusCode: 500, expose: false },
          );
        }

        return Object.freeze({
          ok: true as const,
          latencyMs: Math.max(0, Date.now() - start),
        });
      } catch (err: unknown) {
        throw normalizePrismaError(err);
      }
    },

    async transaction<TResult>(
      fn: (tx: TTxClient) => Promise<TResult>,
      txOptions?: TransactionOptions,
    ): Promise<TResult> {
      if (activeClient === null || currentState !== 'connected') {
        throw new DatabaseConnectionError(
          `Cannot start transaction on Prisma adapter "${adapterName}" while "${currentState}"`,
        );
      }

      if (typeof activeClient.$transaction !== 'function') {
        throw new DatabaseError(
          `Prisma client for "${adapterName}" does not support interactive $transaction()`,
          { code: 'DB_TRANSACTIONS_UNSUPPORTED', statusCode: 500, expose: false },
        );
      }

      let isolationLevel: PrismaIsolationLevel | undefined;
      if (txOptions?.isolationLevel !== undefined) {
        isolationLevel = PRISMA_ISOLATION_MAP[txOptions.isolationLevel];
        if (isolationLevel === undefined) {
          throw new DatabaseError('Unsupported transaction isolation level', {
            code: 'DB_INVALID_TRANSACTION_OPTION',
            statusCode: 400,
            expose: false,
          });
        }
      }

      const prismaTxOpts: PrismaTransactionOptions = {
        ...(isolationLevel !== undefined ? { isolationLevel } : {}),
        ...(options.transactionMaxWaitMs !== undefined
          ? { maxWait: options.transactionMaxWaitMs }
          : {}),
        ...(options.transactionTimeoutMs !== undefined
          ? { timeout: options.transactionTimeoutMs }
          : {}),
      };

      const hasTxOpts = Object.keys(prismaTxOpts).length > 0;

      try {
        if (hasTxOpts) {
          return await activeClient.$transaction(
            (tx) => fn(tx as unknown as TTxClient),
            prismaTxOpts,
          );
        }
        return await activeClient.$transaction((tx) => fn(tx as unknown as TTxClient));
      } catch (err: unknown) {
        throw normalizePrismaError(err);
      }
    },
  };
}

export function createPrismaPlugin<
  TClient extends PrismaClientLike = PrismaClientLike,
  TTxClient = TClient,
>(
  options: PrismaPluginOptions<TClient, TTxClient> = {},
): ForgePlugin<PrismaAdapterOptions<TClient>, PrismaAdapterOptions<TClient>> {
  return createDatabasePlugin<
    TClient,
    TTxClient,
    PrismaAdapterOptions<TClient>,
    PrismaAdapterOptions<TClient>
  >({
    name: options.name ?? '@forge-fr/prisma',
    ...(options.version !== undefined ? { version: options.version } : {}),
    ...(options.forgeVersion !== undefined ? { forgeVersion: options.forgeVersion } : {}),
    adapterToken: (options.adapterToken ?? DefaultPrismaTokens.adapter) as InjectionToken<
      DatabaseAdapter<TClient, TTxClient>
    >,
    clientToken: (options.clientToken ?? DefaultPrismaTokens.client) as InjectionToken<TClient>,
    healthCheckName: options.healthCheckName ?? options.name ?? 'prisma',
    configSchema: prismaConfigSchema as unknown as StandardSchemaLike<
      PrismaAdapterOptions<TClient>,
      PrismaAdapterOptions<TClient>
    >,
    createAdapter: (config) => createPrismaAdapter<TClient, TTxClient>(config),
  });
}
