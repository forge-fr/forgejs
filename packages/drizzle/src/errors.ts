import { DatabaseError, normalizeDatabaseError } from '@forge-fr/database';

function hasDriverCode(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) {
    return false;
  }
  const obj = err as Record<string, unknown>;
  return (
    (typeof obj['code'] === 'string' && obj['code'].length > 0) ||
    (typeof obj['sqlState'] === 'string' && obj['sqlState'].length > 0)
  );
}

/**
 * Unwraps Drizzle ORM error wrappers (such as DrizzleQueryError) whose underlying
 * PostgreSQL/driver SQLSTATE error lives on `.cause`, then maps it into the
 * normalized ForgeJS DatabaseError taxonomy (`expose: false`).
 */
export function normalizeDrizzleError(error: unknown): DatabaseError {
  if (error instanceof DatabaseError) {
    return error;
  }

  let current: unknown = error;
  for (let depth = 0; depth < 6 && current !== undefined && current !== null; depth += 1) {
    if (current instanceof DatabaseError) {
      return current;
    }
    if (hasDriverCode(current)) {
      return normalizeDatabaseError(current);
    }
    if (typeof current === 'object' && 'cause' in current) {
      current = (current as { readonly cause?: unknown }).cause;
    } else {
      break;
    }
  }

  return normalizeDatabaseError(error);
}
