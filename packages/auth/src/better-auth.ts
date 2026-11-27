import { ConfigurationError } from '@forge-fr/core';
import type { ForgeContext, ForgeHttpApp } from '@forge-fr/http';
import { createAuthIdentity, type AuthIdentity, type AuthStrategy } from './types.js';

export interface BetterAuthUserLike {
  readonly id: string;
  readonly role?: string | readonly string[];
  readonly [key: string]: unknown;
}

export interface BetterAuthSessionLike {
  readonly id?: string;
  readonly activeOrganizationId?: string;
  readonly [key: string]: unknown;
}

export interface BetterAuthSessionResult {
  readonly user: BetterAuthUserLike;
  readonly session?: BetterAuthSessionLike;
}

/**
 * Structural contract matching any native Better Auth instance (`betterAuth(...)`)
 * without hiding Better Auth's native handler or API methods.
 */
export interface BetterAuthInstanceLike {
  handler(request: Request): Promise<Response>;
  readonly api: {
    getSession(input: { readonly headers: Headers }): Promise<BetterAuthSessionResult | null>;
  };
}

export function mountBetterAuth(
  app: ForgeHttpApp,
  auth: BetterAuthInstanceLike,
  basePath = '/api/auth',
): void {
  const normalized = basePath.startsWith('/') ? basePath.replace(/\/+$/, '') : `/${basePath.replace(/\/+$/, '')}`;
  if (normalized.length === 0 || normalized === '/') {
    throw new ConfigurationError('Better Auth basePath must be a non-root prefix such as "/api/auth"');
  }

  const handler = async (ctx: ForgeContext): Promise<Response> => auth.handler(ctx.request);
  app.all(`${normalized}/*path`, handler);
  app.all(normalized, handler);
}

export interface BetterAuthStrategyOptions {
  readonly name?: string;
  readonly mapIdentity?: (session: BetterAuthSessionResult) => AuthIdentity;
}

export function createBetterAuthStrategy(
  auth: BetterAuthInstanceLike,
  options: BetterAuthStrategyOptions = {},
): AuthStrategy {
  return {
    name: options.name ?? 'better_auth',
    async authenticate(ctx: ForgeContext): Promise<AuthIdentity | null> {
      const result = await auth.api.getSession({ headers: ctx.request.headers });
      if (result === null || !result.user || typeof result.user.id !== 'string') {
        return null;
      }

      if (options.mapIdentity !== undefined) {
        return options.mapIdentity(result);
      }

      const rawRole = result.user.role;
      const roles =
        typeof rawRole === 'string'
          ? [rawRole]
          : Array.isArray(rawRole)
            ? rawRole.filter((r): r is string => typeof r === 'string')
            : [];

      const tenantId =
        typeof result.session?.activeOrganizationId === 'string'
          ? result.session.activeOrganizationId
          : undefined;

      return createAuthIdentity({
        subject: result.user.id,
        method: 'better_auth',
        ...(result.session?.id !== undefined ? { sessionId: result.session.id } : {}),
        ...(tenantId !== undefined ? { tenantId } : {}),
        roles,
        claims: {
          user: result.user,
          ...(result.session !== undefined ? { session: result.session } : {}),
        },
      });
    },
  };
}
