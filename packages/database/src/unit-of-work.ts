import { DatabaseError, normalizeDatabaseError } from './errors.js';
import type {
  DatabaseAdapter,
  RepositoryFactory,
  TransactionContext,
  TransactionHook,
  TransactionOptions,
  UnitOfWork,
  UnitOfWorkRunOptions,
} from './types.js';

export type {
  RepositoryFactory,
  TransactionContext,
  TransactionHook,
  UnitOfWork,
  UnitOfWorkRunOptions,
};

/**
 * Defines a typed repository factory bound to a native database or transaction client.
 * Preserves the exact native query builder (Drizzle, Prisma, or SQL client) without
 * forcing an artificial universal ORM abstraction.
 */
export function defineRepository<TClient, TRepo>(
  factory: (client: TClient) => TRepo,
  options?: { readonly name?: string },
): RepositoryFactory<TClient, TRepo> {
  if (options?.name !== undefined) {
    Object.defineProperty(factory, 'repositoryName', {
      value: options.name,
      enumerable: false,
      configurable: true,
    });
    Object.defineProperty(factory, 'name', {
      value: options.name,
      enumerable: false,
      configurable: true,
    });
  }
  return factory as RepositoryFactory<TClient, TRepo>;
}

export interface CreateUnitOfWorkOptions<TClient, TTxClient> {
  readonly adapter: DatabaseAdapter<TClient, TTxClient>;
  /** Optional custom error normalizer (e.g., `normalizeDrizzleError` or `normalizePrismaError`). */
  readonly normalizeError?: (error: unknown) => DatabaseError;
  /** Optional callback invoked if an `afterRollback` hook throws while handling an abort. */
  readonly onRollbackHookError?: (hookError: unknown, transactionError: DatabaseError) => void;
}

class TransactionContextImpl<TTxClient> implements TransactionContext<TTxClient> {
  public readonly tx: TTxClient;
  public readonly depth: number;
  private readonly repoCache: Map<RepositoryFactory<TTxClient, unknown>, unknown>;
  private readonly commitHooks: TransactionHook[];
  private readonly rollbackHooks: TransactionHook[];
  private settled = false;

  public constructor(
    tx: TTxClient,
    depth = 0,
    sharedCommitHooks?: TransactionHook[],
    sharedRollbackHooks?: TransactionHook[],
    sharedRepoCache?: Map<RepositoryFactory<TTxClient, unknown>, unknown>,
  ) {
    this.tx = tx;
    this.depth = depth;
    this.commitHooks = sharedCommitHooks ?? [];
    this.rollbackHooks = sharedRollbackHooks ?? [];
    this.repoCache = sharedRepoCache ?? new Map<RepositoryFactory<TTxClient, unknown>, unknown>();
  }

  public createChild(): TransactionContextImpl<TTxClient> {
    return new TransactionContextImpl<TTxClient>(
      this.tx,
      this.depth + 1,
      this.commitHooks,
      this.rollbackHooks,
      this.repoCache,
    );
  }

  public repository<TRepo>(factory: RepositoryFactory<TTxClient, TRepo>): TRepo {
    const typedKey = factory as RepositoryFactory<TTxClient, unknown>;
    if (this.repoCache.has(typedKey)) {
      return this.repoCache.get(typedKey) as TRepo;
    }
    const instance = factory(this.tx);
    this.repoCache.set(typedKey, instance);
    return instance;
  }

  public afterCommit(hook: TransactionHook): this {
    if (this.settled) {
      throw new DatabaseError('Cannot register afterCommit hook after transaction has settled', {
        code: 'DB_TRANSACTION_SETTLED',
        statusCode: 500,
        expose: false,
      });
    }
    this.commitHooks.push(hook);
    return this;
  }

  public afterRollback(hook: TransactionHook): this {
    if (this.settled) {
      throw new DatabaseError('Cannot register afterRollback hook after transaction has settled', {
        code: 'DB_TRANSACTION_SETTLED',
        statusCode: 500,
        expose: false,
      });
    }
    this.rollbackHooks.push(hook);
    return this;
  }

  public async flushCommitHooks(): Promise<void> {
    this.settled = true;
    for (let i = 0; i < this.commitHooks.length; i += 1) {
      const hook = this.commitHooks[i];
      if (hook !== undefined) {
        await hook();
      }
    }
  }

  public async flushRollbackHooks(
    txError: DatabaseError,
    onHookError?: (hookError: unknown, transactionError: DatabaseError) => void,
  ): Promise<void> {
    this.settled = true;
    // Execute rollback hooks in reverse registration order (LIFO)
    for (let i = this.rollbackHooks.length - 1; i >= 0; i -= 1) {
      const hook = this.rollbackHooks[i];
      if (hook !== undefined) {
        try {
          await hook();
        } catch (hookErr: unknown) {
          if (onHookError !== undefined) {
            onHookError(hookErr, txError);
          }
        }
      }
    }
  }
}

/**
 * Creates a `UnitOfWork` coordinator over any `DatabaseAdapter<TClient, TTxClient>`.
 */
export function createUnitOfWork<TClient = unknown, TTxClient = TClient>(
  adapterOrOptions:
    | DatabaseAdapter<TClient, TTxClient>
    | CreateUnitOfWorkOptions<TClient, TTxClient>,
): UnitOfWork<TClient, TTxClient> {
  const isAdapter =
    typeof adapterOrOptions === 'object' &&
    adapterOrOptions !== null &&
    'connect' in adapterOrOptions &&
    'disconnect' in adapterOrOptions &&
    typeof (adapterOrOptions as DatabaseAdapter<TClient, TTxClient>).connect === 'function';

  const adapter: DatabaseAdapter<TClient, TTxClient> = isAdapter
    ? (adapterOrOptions as DatabaseAdapter<TClient, TTxClient>)
    : (adapterOrOptions as CreateUnitOfWorkOptions<TClient, TTxClient>).adapter;

  const normalizeErr =
    !isAdapter &&
    (adapterOrOptions as CreateUnitOfWorkOptions<TClient, TTxClient>).normalizeError !== undefined
      ? (adapterOrOptions as CreateUnitOfWorkOptions<TClient, TTxClient>).normalizeError!
      : normalizeDatabaseError;

  const onRollbackHookError = !isAdapter
    ? (adapterOrOptions as CreateUnitOfWorkOptions<TClient, TTxClient>).onRollbackHookError
    : undefined;

  return {
    adapter,

    get client(): TClient {
      return adapter.client;
    },

    repository<TRepo>(factory: RepositoryFactory<TClient, TRepo>): TRepo {
      return factory(adapter.client);
    },

    async run<TResult>(
      work: (ctx: TransactionContext<TTxClient>) => Promise<TResult>,
      options?: UnitOfWorkRunOptions,
    ): Promise<TResult> {
      if (options?.parent !== undefined) {
        const parentCtx = options.parent as TransactionContext<TTxClient>;
        const childCtx =
          parentCtx instanceof TransactionContextImpl
            ? parentCtx.createChild()
            : new TransactionContextImpl<TTxClient>(parentCtx.tx, parentCtx.depth + 1);
        try {
          return await work(childCtx);
        } catch (err: unknown) {
          throw normalizeErr(err);
        }
      }

      if (typeof adapter.transaction !== 'function') {
        throw new DatabaseError(
          `Database adapter "${adapter.name}" (${adapter.driver}) does not support transactions`,
          { code: 'DB_TRANSACTIONS_UNSUPPORTED', statusCode: 500, expose: false },
        );
      }

      let rootCtx: TransactionContextImpl<TTxClient> | null = null;
      let result: TResult;

      const txOptions: TransactionOptions | undefined =
        options !== undefined
          ? {
              ...(options.isolationLevel !== undefined
                ? { isolationLevel: options.isolationLevel }
                : {}),
              ...(options.readOnly !== undefined ? { readOnly: options.readOnly } : {}),
              ...(options.deferrable !== undefined ? { deferrable: options.deferrable } : {}),
            }
          : undefined;

      try {
        result = await adapter.transaction(async (tx) => {
          rootCtx = new TransactionContextImpl<TTxClient>(tx, 0);
          return work(rootCtx);
        }, txOptions);
      } catch (err: unknown) {
        const normalized = normalizeErr(err);
        if (rootCtx !== null) {
          await (rootCtx as TransactionContextImpl<TTxClient>).flushRollbackHooks(
            normalized,
            onRollbackHookError,
          );
        }
        throw normalized;
      }

      if (rootCtx !== null) {
        await (rootCtx as TransactionContextImpl<TTxClient>).flushCommitHooks();
      }

      return result;
    },
  };
}
