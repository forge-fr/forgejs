import postgres from 'postgres';
import {
  isSecretValue,
  type ForgePlugin,
  type InjectionToken,
  type SecretValue,
  type StandardSchemaIssueLike,
  type StandardSchemaLike,
} from '@forge-fr/core';
import {
  DatabaseConnectionError,
  DatabaseError,
  normalizeDatabaseError,
  redactDatabaseUrl,
} from './errors.js';
import { createDatabasePlugin } from './plugin.js';
import type {
  DatabaseAdapter,
  DatabaseConnectionState,
  DatabasePingResult,
  TransactionIsolationLevel,
  TransactionOptions,
} from './types.js';

export type PostgresSslMode = boolean | 'require' | 'prefer' | 'allow' | 'verify-full';

export interface PostgresClientLike {
  <TRow extends Record<string, unknown> = Record<string, unknown>>(
    strings: TemplateStringsArray,
    ...parameters: readonly unknown[]
  ): Promise<readonly TRow[]>;
  unsafe<TRow extends Record<string, unknown> = Record<string, unknown>>(
    query: string,
    parameters?: readonly unknown[],
  ): Promise<readonly TRow[]>;
  begin<TResult>(cb: (tx: PostgresClientLike) => Promise<TResult>): Promise<TResult>;
  begin<TResult>(
    options: string,
    cb: (tx: PostgresClientLike) => Promise<TResult>,
  ): Promise<TResult>;
  end(options?: { readonly timeout?: number }): Promise<void>;
}

export type PostgresDriverFactory = (
  url: string,
  options: PostgresAdapterOptions,
) => PostgresClientLike;

export interface PostgresAdapterOptions {
  readonly name?: string;
  readonly url: string | SecretValue<string>;
  readonly max?: number;
  readonly connectTimeoutSeconds?: number;
  readonly idleTimeoutSeconds?: number;
  readonly maxLifetimeSeconds?: number;
  readonly endTimeoutSeconds?: number;
  readonly prepare?: boolean;
  readonly ssl?: PostgresSslMode;
  readonly driverFactory?: PostgresDriverFactory;
}

export interface PostgresPluginOptions {
  readonly name?: string;
  readonly version?: string;
  readonly forgeVersion?: string;
  readonly adapterToken?: InjectionToken<DatabaseAdapter<PostgresClientLike, PostgresClientLike>>;
  readonly clientToken?: InjectionToken<PostgresClientLike>;
  readonly healthCheckName?: string;
}

const VALID_SSL_STRINGS = new Set<string>(['require', 'prefer', 'allow', 'verify-full']);

const ISOLATION_LEVEL_SQL: Readonly<Record<TransactionIsolationLevel, string>> = Object.freeze({
  read_uncommitted: 'ISOLATION LEVEL READ UNCOMMITTED',
  read_committed: 'ISOLATION LEVEL READ COMMITTED',
  repeatable_read: 'ISOLATION LEVEL REPEATABLE READ',
  serializable: 'ISOLATION LEVEL SERIALIZABLE',
});

function hasValidPostgresScheme(rawUrl: string): boolean {
  const lower = rawUrl.toLowerCase();
  if (!lower.startsWith('postgres://') && !lower.startsWith('postgresql://')) {
    return false;
  }
  const sep = rawUrl.indexOf('://');
  const rest = rawUrl.slice(sep + 3);
  return rest.length > 0 && !rest.startsWith('/');
}

export const postgresConfigSchema: StandardSchemaLike<
  PostgresAdapterOptions,
  PostgresAdapterOptions
> = Object.freeze({
  '~standard': Object.freeze({
    version: 1 as const,
    vendor: 'forgejs',
    validate(value: unknown) {
      const issues: StandardSchemaIssueLike[] = [];

      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return {
          issues: [{ message: 'PostgreSQL configuration must be an object' }],
        };
      }

      const cfg = value as Record<string, unknown>;
      const rawUrlValue = cfg['url'];
      let unwrappedUrl: string | undefined;

      if (typeof rawUrlValue === 'string') {
        unwrappedUrl = rawUrlValue;
      } else if (isSecretValue(rawUrlValue)) {
        const revealed = rawUrlValue.reveal();
        if (typeof revealed === 'string') {
          unwrappedUrl = revealed;
        }
      }

      if (unwrappedUrl === undefined || !hasValidPostgresScheme(unwrappedUrl)) {
        issues.push({
          path: ['url'],
          message: 'Expected a valid postgres:// or postgresql:// connection URL',
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

      if (cfg['max'] !== undefined) {
        if (
          typeof cfg['max'] !== 'number' ||
          !Number.isInteger(cfg['max']) ||
          cfg['max'] < 1 ||
          cfg['max'] > 1000
        ) {
          issues.push({
            path: ['max'],
            message: 'Pool max connections must be an integer between 1 and 1000',
          });
        }
      }

      if (cfg['connectTimeoutSeconds'] !== undefined) {
        if (
          typeof cfg['connectTimeoutSeconds'] !== 'number' ||
          !Number.isFinite(cfg['connectTimeoutSeconds']) ||
          cfg['connectTimeoutSeconds'] <= 0
        ) {
          issues.push({
            path: ['connectTimeoutSeconds'],
            message: 'connectTimeoutSeconds must be a positive number',
          });
        }
      }

      for (const field of ['idleTimeoutSeconds', 'maxLifetimeSeconds', 'endTimeoutSeconds'] as const) {
        const val = cfg[field];
        if (val !== undefined) {
          if (typeof val !== 'number' || !Number.isFinite(val) || val < 0) {
            issues.push({
              path: [field],
              message: `${field} must be a non-negative finite number`,
            });
          }
        }
      }

      if (cfg['prepare'] !== undefined && typeof cfg['prepare'] !== 'boolean') {
        issues.push({
          path: ['prepare'],
          message: 'prepare must be a boolean',
        });
      }

      if (cfg['ssl'] !== undefined) {
        const ssl = cfg['ssl'];
        const isValidSsl =
          typeof ssl === 'boolean' || (typeof ssl === 'string' && VALID_SSL_STRINGS.has(ssl));
        if (!isValidSsl) {
          issues.push({
            path: ['ssl'],
            message: 'ssl must be a boolean or one of require, prefer, allow, verify-full',
          });
        }
      }

      if (cfg['driverFactory'] !== undefined && typeof cfg['driverFactory'] !== 'function') {
        issues.push({
          path: ['driverFactory'],
          message: 'driverFactory must be a function',
        });
      }

      if (issues.length > 0) {
        return { issues };
      }

      return { value: cfg as unknown as PostgresAdapterOptions };
    },
  }),
});

function buildTransactionMode(options?: TransactionOptions): string | undefined {
  if (options === undefined) {
    return undefined;
  }

  const clauses: string[] = [];

  if (options.isolationLevel !== undefined) {
    const sqlClause = ISOLATION_LEVEL_SQL[options.isolationLevel];
    if (sqlClause === undefined) {
      throw new DatabaseError(`Unsupported transaction isolation level`, {
        code: 'DB_INVALID_TRANSACTION_OPTION',
        statusCode: 400,
        expose: false,
      });
    }
    clauses.push(sqlClause);
  }

  if (options.readOnly === true) {
    clauses.push('READ ONLY');
  } else if (options.readOnly === false) {
    clauses.push('READ WRITE');
  }

  if (options.deferrable === true) {
    clauses.push('DEFERRABLE');
  } else if (options.deferrable === false) {
    clauses.push('NOT DEFERRABLE');
  }

  return clauses.length > 0 ? clauses.join(' ') : undefined;
}

function createNativePostgresClient(
  url: string,
  options: PostgresAdapterOptions,
): PostgresClientLike {
  const nativeOptions: postgres.Options<Record<string, postgres.PostgresType>> = {
    max: options.max ?? 10,
    connect_timeout: options.connectTimeoutSeconds ?? 10,
    ...(options.idleTimeoutSeconds !== undefined
      ? { idle_timeout: options.idleTimeoutSeconds }
      : {}),
    ...(options.maxLifetimeSeconds !== undefined
      ? { max_lifetime: options.maxLifetimeSeconds }
      : {}),
    ...(options.prepare !== undefined ? { prepare: options.prepare } : {}),
    ...(options.ssl !== undefined ? { ssl: options.ssl } : {}),
  };

  return postgres(url, nativeOptions) as unknown as PostgresClientLike;
}

function sanitizeMessage(message: string, rawUrl: string, safeUrl: string): string {
  let sanitized = message;
  if (rawUrl.length > 0 && sanitized.includes(rawUrl)) {
    sanitized = sanitized.split(rawUrl).join(safeUrl);
  }
  // Redact any embedded password if the raw URL contained user:password@
  const schemeIdx = rawUrl.indexOf('://');
  if (schemeIdx > 0) {
    const rest = rawUrl.slice(schemeIdx + 3);
    const authorityEnd = rest.search(/[/?#]/);
    const authority = authorityEnd === -1 ? rest : rest.slice(0, authorityEnd);
    const atIdx = authority.lastIndexOf('@');
    if (atIdx > 0) {
      const userInfo = authority.slice(0, atIdx);
      const colonIdx = userInfo.indexOf(':');
      if (colonIdx >= 0) {
        const password = userInfo.slice(colonIdx + 1);
        if (password.length > 0 && sanitized.includes(password)) {
          sanitized = sanitized.split(password).join('[REDACTED]');
        }
      }
    }
  }
  return sanitized;
}

export function createPostgresAdapter(
  options: PostgresAdapterOptions,
): DatabaseAdapter<PostgresClientLike, PostgresClientLike> {
  const adapterName = options.name ?? 'postgres';
  const endTimeoutSeconds = options.endTimeoutSeconds ?? 5;
  let currentState: DatabaseConnectionState = 'disconnected';
  let activeClient: PostgresClientLike | null = null;

  return {
    name: adapterName,
    driver: 'postgres',

    get state(): DatabaseConnectionState {
      return currentState;
    },

    get client(): PostgresClientLike {
      if (activeClient === null || currentState !== 'connected') {
        throw new DatabaseConnectionError(
          `PostgreSQL adapter "${adapterName}" is not connected (current state: "${currentState}")`,
        );
      }
      return activeClient;
    },

    async connect(): Promise<void> {
      if (currentState === 'connected' && activeClient !== null) {
        return;
      }

      const rawUrl = isSecretValue(options.url) ? String(options.url.reveal()) : options.url;
      const safeUrl = redactDatabaseUrl(rawUrl);

      if (!hasValidPostgresScheme(rawUrl)) {
        currentState = 'error';
        throw new DatabaseConnectionError(
          `Invalid PostgreSQL connection URL for adapter "${adapterName}" (${safeUrl})`,
          { retryable: false },
        );
      }

      currentState = 'connecting';
      let candidateClient: PostgresClientLike | null = null;

      try {
        candidateClient = options.driverFactory
          ? options.driverFactory(rawUrl, options)
          : createNativePostgresClient(rawUrl, options);

        await candidateClient`SELECT 1`;
        activeClient = candidateClient;
        currentState = 'connected';
      } catch (err: unknown) {
        currentState = 'error';
        activeClient = null;
        if (candidateClient !== null) {
          try {
            await candidateClient.end({ timeout: 0 });
          } catch {
            // Best-effort cleanup of failed connection pool
          }
        }
        const normalized = normalizeDatabaseError(err);
        const safeDetail = sanitizeMessage(normalized.message, rawUrl, safeUrl);
        throw new DatabaseConnectionError(
          `Failed to connect PostgreSQL adapter "${adapterName}" (${safeUrl}): ${safeDetail}`,
          {
            cause: err,
            ...(normalized.sqlState !== undefined ? { sqlState: normalized.sqlState } : {}),
            ...(normalized.driverCode !== undefined ? { driverCode: normalized.driverCode } : {}),
            retryable: true,
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
        await clientToClose.end({ timeout: endTimeoutSeconds });
        currentState = 'disconnected';
      } catch (err: unknown) {
        currentState = 'error';
        throw normalizeDatabaseError(err);
      }
    },

    async ping(): Promise<DatabasePingResult> {
      if (activeClient === null || currentState !== 'connected') {
        throw new DatabaseConnectionError(
          `Cannot ping PostgreSQL adapter "${adapterName}" while "${currentState}"`,
        );
      }

      const start = Date.now();
      try {
        await activeClient`SELECT 1`;
        return Object.freeze({
          ok: true as const,
          latencyMs: Math.max(0, Date.now() - start),
        });
      } catch (err: unknown) {
        throw normalizeDatabaseError(err);
      }
    },

    async transaction<TResult>(
      fn: (tx: PostgresClientLike) => Promise<TResult>,
      txOptions?: TransactionOptions,
    ): Promise<TResult> {
      if (activeClient === null || currentState !== 'connected') {
        throw new DatabaseConnectionError(
          `Cannot start transaction on PostgreSQL adapter "${adapterName}" while "${currentState}"`,
        );
      }

      const mode = buildTransactionMode(txOptions);

      try {
        if (mode !== undefined) {
          return await activeClient.begin(mode, fn);
        }
        return await activeClient.begin(fn);
      } catch (err: unknown) {
        throw normalizeDatabaseError(err);
      }
    },
  };
}

export function createPostgresPlugin(
  options: PostgresPluginOptions = {},
): ForgePlugin<PostgresAdapterOptions, PostgresAdapterOptions> {
  return createDatabasePlugin<
    PostgresClientLike,
    PostgresClientLike,
    PostgresAdapterOptions,
    PostgresAdapterOptions
  >({
    name: options.name ?? '@forge-fr/database-postgres',
    ...(options.version !== undefined ? { version: options.version } : {}),
    ...(options.forgeVersion !== undefined ? { forgeVersion: options.forgeVersion } : {}),
    ...(options.adapterToken !== undefined ? { adapterToken: options.adapterToken } : {}),
    ...(options.clientToken !== undefined ? { clientToken: options.clientToken } : {}),
    healthCheckName: options.healthCheckName ?? options.name ?? 'postgres',
    configSchema: postgresConfigSchema,
    createAdapter: (config) => createPostgresAdapter(config),
  });
}
