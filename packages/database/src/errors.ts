import { ForgeError, isSecretValue, type ForgeErrorOptions, type SecretValue } from '@forge-fr/core';

export interface DatabaseErrorOptions extends Omit<ForgeErrorOptions, 'code' | 'statusCode'> {
  readonly code?: string;
  readonly statusCode?: number;
  readonly sqlState?: string;
  readonly driverCode?: string;
  readonly constraint?: string;
  readonly table?: string;
  readonly column?: string;
  readonly retryable?: boolean;
}

export class DatabaseError extends ForgeError {
  public readonly sqlState?: string;
  public readonly driverCode?: string;
  public readonly constraint?: string;
  public readonly table?: string;
  public readonly column?: string;
  public readonly retryable: boolean;

  public constructor(message: string, options: DatabaseErrorOptions = {}) {
    super(message, {
      code: options.code ?? 'DB_ERROR',
      statusCode: options.statusCode ?? 500,
      expose: options.expose ?? false,
      ...(options.details !== undefined ? { details: options.details } : {}),
      ...(options.cause !== undefined ? { cause: options.cause } : {}),
    });
    if (options.sqlState !== undefined) this.sqlState = options.sqlState;
    if (options.driverCode !== undefined) this.driverCode = options.driverCode;
    if (options.constraint !== undefined) this.constraint = options.constraint;
    if (options.table !== undefined) this.table = options.table;
    if (options.column !== undefined) this.column = options.column;
    this.retryable = options.retryable ?? false;
  }
}

export class DatabaseConnectionError extends DatabaseError {
  public constructor(message = 'Database connection error', options: DatabaseErrorOptions = {}) {
    super(message, {
      ...options,
      code: 'DB_CONNECTION_ERROR',
      statusCode: 503,
      expose: false,
      retryable: options.retryable ?? true,
    });
  }
}

export class DatabaseUniqueViolationError extends DatabaseError {
  public constructor(message = 'Database unique constraint violated', options: DatabaseErrorOptions = {}) {
    super(message, {
      ...options,
      code: 'DB_UNIQUE_VIOLATION',
      statusCode: 409,
      expose: false,
    });
  }
}

export class DatabaseForeignKeyViolationError extends DatabaseError {
  public constructor(
    message = 'Database foreign key constraint violated',
    options: DatabaseErrorOptions = {},
  ) {
    super(message, {
      ...options,
      code: 'DB_FOREIGN_KEY_VIOLATION',
      statusCode: 409,
      expose: false,
    });
  }
}

export class DatabaseNotNullViolationError extends DatabaseError {
  public constructor(
    message = 'Database not-null constraint violated',
    options: DatabaseErrorOptions = {},
  ) {
    super(message, {
      ...options,
      code: 'DB_NOT_NULL_VIOLATION',
      statusCode: 400,
      expose: false,
    });
  }
}

export class DatabaseCheckViolationError extends DatabaseError {
  public constructor(
    message = 'Database check constraint violated',
    options: DatabaseErrorOptions = {},
  ) {
    super(message, {
      ...options,
      code: 'DB_CHECK_VIOLATION',
      statusCode: 400,
      expose: false,
    });
  }
}

export class DatabaseSerializationError extends DatabaseError {
  public constructor(
    message = 'Database transaction serialization failure',
    options: DatabaseErrorOptions = {},
  ) {
    super(message, {
      ...options,
      code: 'DB_SERIALIZATION_FAILURE',
      statusCode: 409,
      expose: false,
      retryable: true,
    });
  }
}

export class DatabaseTimeoutError extends DatabaseError {
  public constructor(message = 'Database operation timed out', options: DatabaseErrorOptions = {}) {
    super(message, {
      ...options,
      code: 'DB_TIMEOUT',
      statusCode: 504,
      expose: false,
      retryable: options.retryable ?? true,
    });
  }
}

interface DriverErrorLike {
  readonly code?: unknown;
  readonly sqlState?: unknown;
  readonly constraint_name?: unknown;
  readonly constraint?: unknown;
  readonly table_name?: unknown;
  readonly table?: unknown;
  readonly column_name?: unknown;
  readonly column?: unknown;
  readonly message?: unknown;
}

const CONNECTION_CODES = new Set([
  '08000',
  '08001',
  '08003',
  '08004',
  '08006',
  '08007',
  '08P01',
  '57P01',
  '57P02',
  '57P03',
  'ECONNREFUSED',
  'ECONNRESET',
  'ENOTFOUND',
  'EHOSTUNREACH',
  'EPIPE',
  'CONNECTION_CLOSED',
  'CONNECTION_ENDED',
  'CONNECTION_DESTROYED',
]);

const TIMEOUT_CODES = new Set(['57014', '55P03', 'CONNECT_TIMEOUT', 'ETIMEDOUT', 'STATEMENT_TIMEOUT']);

function readStringField(obj: DriverErrorLike, ...keys: (keyof DriverErrorLike)[]): string | undefined {
  for (const key of keys) {
    const val = obj[key];
    if (typeof val === 'string' && val.length > 0) {
      return val;
    }
  }
  return undefined;
}

export function normalizeDatabaseError(error: unknown): DatabaseError {
  if (error instanceof DatabaseError) {
    return error;
  }

  const errObj: DriverErrorLike =
    typeof error === 'object' && error !== null ? (error as DriverErrorLike) : {};

  const rawCode = readStringField(errObj, 'code', 'sqlState');
  const constraint = readStringField(errObj, 'constraint_name', 'constraint');
  const table = readStringField(errObj, 'table_name', 'table');
  const column = readStringField(errObj, 'column_name', 'column');
  const rawMessage =
    readStringField(errObj, 'message') ??
    (error instanceof Error ? error.message : 'Database operation failed');

  const baseOptions: DatabaseErrorOptions = {
    cause: error,
    ...(rawCode !== undefined && rawCode.length === 5 ? { sqlState: rawCode } : {}),
    ...(rawCode !== undefined ? { driverCode: rawCode } : {}),
    ...(constraint !== undefined ? { constraint } : {}),
    ...(table !== undefined ? { table } : {}),
    ...(column !== undefined ? { column } : {}),
  };

  if (rawCode === '23505') {
    return new DatabaseUniqueViolationError('Unique constraint violation', baseOptions);
  }
  if (rawCode === '23503') {
    return new DatabaseForeignKeyViolationError('Foreign key constraint violation', baseOptions);
  }
  if (rawCode === '23502') {
    return new DatabaseNotNullViolationError('Not-null constraint violation', baseOptions);
  }
  if (rawCode === '23514') {
    return new DatabaseCheckViolationError('Check constraint violation', baseOptions);
  }
  if (rawCode === '40001' || rawCode === '40P01') {
    return new DatabaseSerializationError('Transaction serialization or deadlock failure', baseOptions);
  }
  if (rawCode !== undefined && TIMEOUT_CODES.has(rawCode)) {
    return new DatabaseTimeoutError('Database operation timed out', baseOptions);
  }
  if (rawCode !== undefined && (CONNECTION_CODES.has(rawCode) || rawCode.startsWith('08'))) {
    return new DatabaseConnectionError('Database connection error', baseOptions);
  }

  return new DatabaseError(rawMessage, baseOptions);
}

export function redactDatabaseUrl(input: string | SecretValue<string>): string {
  const raw = isSecretValue(input) ? String(input.reveal()) : input;
  if (typeof raw !== 'string' || raw.length === 0) {
    return '[REDACTED_DATABASE_URL]';
  }

  const schemeSep = raw.indexOf('://');
  if (schemeSep <= 0) {
    return '[REDACTED_DATABASE_URL]';
  }

  const scheme = raw.slice(0, schemeSep);
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*$/.test(scheme)) {
    return '[REDACTED_DATABASE_URL]';
  }

  const rest = raw.slice(schemeSep + 3);
  let authorityEnd = rest.length;
  for (const sep of ['/', '?', '#']) {
    const idx = rest.indexOf(sep);
    if (idx !== -1 && idx < authorityEnd) {
      authorityEnd = idx;
    }
  }

  const authority = rest.slice(0, authorityEnd);
  const suffix = rest.slice(authorityEnd);
  if (authority.length === 0) {
    return '[REDACTED_DATABASE_URL]';
  }

  const atIdx = authority.lastIndexOf('@');
  if (atIdx === -1) {
    return `${scheme}://${authority}${suffix}`;
  }

  const userInfo = authority.slice(0, atIdx);
  const hostPort = authority.slice(atIdx + 1);
  if (hostPort.length === 0) {
    return '[REDACTED_DATABASE_URL]';
  }

  const colonIdx = userInfo.indexOf(':');
  if (colonIdx === -1) {
    return `${scheme}://${userInfo}@${hostPort}${suffix}`;
  }

  const username = userInfo.slice(0, colonIdx);
  return `${scheme}://${username}:[REDACTED]@${hostPort}${suffix}`;
}
