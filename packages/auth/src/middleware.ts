import { ConfigurationError, UnauthorizedError } from '@forge-fr/core';
import type { ForgeContext, ForgeMiddleware } from '@forge-fr/http';
import type { AuthIdentity, AuthStrategy } from './types.js';

const AUTH_IDENTITY_MAP = new WeakMap<ForgeContext, AuthIdentity>();

export function setAuthIdentity(ctx: ForgeContext, identity: AuthIdentity): void {
  AUTH_IDENTITY_MAP.set(ctx, identity);
}

export function getAuth(ctx: ForgeContext): AuthIdentity | undefined {
  return AUTH_IDENTITY_MAP.get(ctx);
}

export function requireAuth(ctx: ForgeContext): AuthIdentity {
  const identity = AUTH_IDENTITY_MAP.get(ctx);
  if (identity === undefined) {
    throw new UnauthorizedError('Authentication required');
  }
  return identity;
}

export interface AuthMiddlewareOptions {
  readonly strategies: readonly AuthStrategy[];
  /** When true, unauthenticated requests proceed with `getAuth(ctx) === undefined` instead of 401. */
  readonly optional?: boolean;
}

export function createAuthMiddleware(options: AuthMiddlewareOptions): ForgeMiddleware {
  if (!Array.isArray(options.strategies) || options.strategies.length === 0) {
    throw new ConfigurationError('createAuthMiddleware requires at least one AuthStrategy');
  }

  const optional = options.optional ?? false;

  return async (ctx, next) => {
    let lastAuthError: UnauthorizedError | null = null;

    for (const strategy of options.strategies) {
      try {
        const identity = await strategy.authenticate(ctx);
        if (identity !== null) {
          setAuthIdentity(ctx, identity);
          return next();
        }
      } catch (err: unknown) {
        if (err instanceof UnauthorizedError) {
          lastAuthError = err;
          continue;
        }
        throw err;
      }
    }

    if (optional && lastAuthError === null) {
      return next();
    }

    throw lastAuthError ?? new UnauthorizedError('Authentication required');
  };
}
