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

export interface DatabaseTokens<TClient = unknown, TTxClient = TClient> {
  readonly adapter: InjectionToken<DatabaseAdapter<TClient, TTxClient>>;
  readonly client: InjectionToken<TClient>;
}

export function createDatabaseToken<TClient = unknown, TTxClient = TClient>(
  name = 'default',
): DatabaseTokens<TClient, TTxClient> {
  return Object.freeze({
    adapter: createToken<DatabaseAdapter<TClient, TTxClient>>(`DatabaseAdapter:${name}`),
    client: createToken<TClient>(`DatabaseClient:${name}`),
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
