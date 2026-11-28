import { ConfigurationError, UnauthorizedError } from '@forge-fr/core';
import { createContextKey, type ContextKey, type ForgeContext, type ForgeMiddleware } from '@forge-fr/http';
import type { AuthIdentity, AuthStrategy } from './types.js';

/** Official typed context key storing the authenticated `AuthIdentity` for the current request. */
export const AuthIdentityKey: ContextKey<AuthIdentity> = createContextKey<AuthIdentity>('auth.identity');

const FALLBACK_AUTH_IDENTITY_MAP = new WeakMap<ForgeContext, AuthIdentity>();

export function setAuthIdentity(ctx: ForgeContext, identity: AuthIdentity): void {
  if (typeof ctx.set === 'function') {
    ctx.set(AuthIdentityKey, identity);
  }
  FALLBACK_AUTH_IDENTITY_MAP.set(ctx, identity);
}

export function getAuth(ctx: ForgeContext): AuthIdentity | undefined {
  if (typeof ctx.get === 'function') {
    const typed = ctx.get(AuthIdentityKey);
    if (typed !== undefined) {
      return typed;
    }
  }
  return FALLBACK_AUTH_IDENTITY_MAP.get(ctx);
}

export function requireAuth(ctx: ForgeContext): AuthIdentity {
  const identity = getAuth(ctx);
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
