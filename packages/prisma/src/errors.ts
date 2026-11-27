import {
  DatabaseConnectionError,
  DatabaseError,
  DatabaseForeignKeyViolationError,
  DatabaseNotNullViolationError,
  DatabaseSerializationError,
  DatabaseTimeoutError,
  DatabaseUniqueViolationError,
  normalizeDatabaseError,
  type DatabaseErrorOptions,
} from '@forge-fr/database';

interface PrismaErrorLike {
  readonly code?: unknown;
  readonly message?: unknown;
  readonly meta?: unknown;
  readonly cause?: unknown;
}

const PRISMA_CONNECTION_CODES = new Set(['P1000', 'P1001', 'P1003', 'P1011', 'P1017']);
const PRISMA_TIMEOUT_CODES = new Set(['P1002', 'P1008', 'P2024']);

function readMetaString(meta: Record<string, unknown>, key: string): string | undefined {
  const val = meta[key];
  if (typeof val === 'string' && val.length > 0) {
    return val;
  }
  if (Array.isArray(val)) {
    const parts = val.filter((item): item is string => typeof item === 'string' && item.length > 0);
    if (parts.length > 0) {
      return parts.join(', ');
    }
  }
  return undefined;
}

/**
 * Normalizes Prisma Known Request / Initialization errors (P1xxx / P2xxx) as well as
 * underlying driver-adapter SQLSTATE errors into ForgeJS DatabaseError subclasses (`expose: false`).
 */
export function normalizePrismaError(error: unknown): DatabaseError {
  if (error instanceof DatabaseError) {
    return error;
  }

  const errObj: PrismaErrorLike =
    typeof error === 'object' && error !== null ? (error as PrismaErrorLike) : {};

  const code = typeof errObj.code === 'string' && errObj.code.length > 0 ? errObj.code : undefined;
  const meta: Record<string, unknown> =
    typeof errObj.meta === 'object' && errObj.meta !== null && !Array.isArray(errObj.meta)
      ? (errObj.meta as Record<string, unknown>)
      : {};

  if (code !== undefined && code.startsWith('P')) {
    const table = readMetaString(meta, 'modelName');
    const target = readMetaString(meta, 'target');
    const fieldName = readMetaString(meta, 'field_name');
    const constraint = readMetaString(meta, 'constraint') ?? fieldName ?? target;
    const column = readMetaString(meta, 'column_name') ?? target;

    const baseOptions: DatabaseErrorOptions = {
      cause: error,
      driverCode: code,
      ...(table !== undefined ? { table } : {}),
      ...(constraint !== undefined ? { constraint } : {}),
      ...(column !== undefined ? { column } : {}),
    };

    if (code === 'P2002') {
      return new DatabaseUniqueViolationError('Prisma unique constraint violation', baseOptions);
    }
    if (code === 'P2003') {
      return new DatabaseForeignKeyViolationError(
        'Prisma foreign key constraint violation',
        baseOptions,
      );
    }
    if (code === 'P2011') {
      return new DatabaseNotNullViolationError('Prisma not-null constraint violation', baseOptions);
    }
    if (code === 'P2034') {
      return new DatabaseSerializationError(
        'Prisma transaction write conflict or deadlock',
        baseOptions,
      );
    }
    if (PRISMA_TIMEOUT_CODES.has(code)) {
      return new DatabaseTimeoutError('Prisma database operation timed out', baseOptions);
    }
    if (PRISMA_CONNECTION_CODES.has(code)) {
      return new DatabaseConnectionError('Prisma database connection error', baseOptions);
    }

    return new DatabaseError('Prisma database operation failed', baseOptions);
  }

  if (errObj.cause !== undefined && errObj.cause !== null) {
    const normalizedCause = normalizeDatabaseError(errObj.cause);
    if (normalizedCause.driverCode !== undefined || normalizedCause.sqlState !== undefined) {
      return normalizedCause;
    }
  }

  return normalizeDatabaseError(error);
}
