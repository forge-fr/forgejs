import { createToken, type InjectionToken } from '@forge-fr/core';
import { DatabaseError, normalizeDatabaseError } from './errors.js';

export type DatabaseConnectionState =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'disconnecting'
  | 'error';

export type TransactionIsolationLevel =
  | 'read_uncommitted'
  | 'read_committed'
  | 'repeatable_read'
  | 'serializable';

export interface TransactionOptions {
  readonly isolationLevel?: TransactionIsolationLevel;
  readonly readOnly?: boolean;
  readonly deferrable?: boolean;
}

export interface DatabasePingResult {
  readonly ok: true;
  readonly latencyMs: number;
}

export interface DatabaseAdapter<TClient = unknown, TTxClient = TClient> {
  readonly name: string;
  readonly driver: string;
  readonly state: DatabaseConnectionState;
  readonly client: TClient;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  ping(): Promise<DatabasePingResult>;
  transaction?<TResult>(
    fn: (tx: TTxClient) => Promise<TResult>,
    options?: TransactionOptions,
  ): Promise<TResult>;
}

export type TransactionHook = () => Promise<void> | void;

export type RepositoryFactory<TClient, TRepo> = ((client: TClient) => TRepo) & {
  readonly repositoryName?: string;
};

export interface TransactionContext<TTxClient> {
  /** Native transaction client (e.g., Drizzle transaction, Prisma interactive tx, or SQL tx). */
  readonly tx: TTxClient;
  /** Nesting depth (`0` for root transaction, `>= 1` when reusing or nesting inside an outer context). */
  readonly depth: number;
  /** Instantiates (and memoizes per transaction context) a typed repository bound to `this.tx`. */
  repository<TRepo>(factory: RepositoryFactory<TTxClient, TRepo>): TRepo;
  /**
   * Registers a callback that runs only after the root transaction commits to the database.
   * Ideal for publishing domain events, enqueuing background jobs, or invalidating caches.
   */
  afterCommit(hook: TransactionHook): this;
  /**
   * Registers a compensating callback that runs if the transaction rolls back.
   */
  afterRollback(hook: TransactionHook): this;
}

export interface UnitOfWorkRunOptions extends TransactionOptions {
  /**
   * Optional parent `TransactionContext` to join. When provided, `uow.run()` reuses the parent's
   * active transaction client (`parent.tx`) and defers `afterCommit` / `afterRollback` hooks to
   * the root transaction boundary.
   */
  readonly parent?: TransactionContext<unknown>;
}

export interface UnitOfWork<TClient = unknown, TTxClient = TClient> {
  readonly adapter: DatabaseAdapter<TClient, TTxClient>;
  /** Direct access to the non-transactional connected client on the underlying adapter. */
  readonly client: TClient;
  /** Instantiates a repository bound to the non-transactional adapter client (`adapter.client`). */
  repository<TRepo>(factory: RepositoryFactory<TClient, TRepo>): TRepo;
  /**
   * Executes `work` inside an atomic database transaction with automatic rollback on throw,
   * normalized `DatabaseError` mapping, and `afterCommit` / `afterRollback` hook execution.
   */
  run<TResult>(
    work: (ctx: TransactionContext<TTxClient>) => Promise<TResult>,
    options?: UnitOfWorkRunOptions,
  ): Promise<TResult>;
}

export interface DatabaseTokens<TClient = unknown, TTxClient = TClient> {
  readonly adapter: InjectionToken<DatabaseAdapter<TClient, TTxClient>>;
  readonly client: InjectionToken<TClient>;
  readonly unitOfWork: InjectionToken<UnitOfWork<TClient, TTxClient>>;
}

export function createDatabaseToken<TClient = unknown, TTxClient = TClient>(
  name = 'default',
): DatabaseTokens<TClient, TTxClient> {
  return Object.freeze({
    adapter: createToken<DatabaseAdapter<TClient, TTxClient>>(`DatabaseAdapter:${name}`),
    client: createToken<TClient>(`DatabaseClient:${name}`),
    unitOfWork: createToken<UnitOfWork<TClient, TTxClient>>(`DatabaseUnitOfWork:${name}`),
  });
}

export const DefaultDatabaseTokens = createDatabaseToken<unknown>('default');

export async function runInTransaction<TClient, TTxClient, TResult>(
  adapter: DatabaseAdapter<TClient, TTxClient>,
  fn: (tx: TTxClient) => Promise<TResult>,
  options?: TransactionOptions,
): Promise<TResult> {
  if (typeof adapter.transaction !== 'function') {
    throw new DatabaseError(
      `Database adapter "${adapter.name}" (${adapter.driver}) does not support transactions`,
      { code: 'DB_TRANSACTIONS_UNSUPPORTED', statusCode: 500, expose: false },
    );
  }

  try {
    return await adapter.transaction(fn, options);
  } catch (err: unknown) {
    throw normalizeDatabaseError(err);
  }
}
