import { createAuthMiddleware } from '@forge-fr/auth';
import type { ForgeMiddleware } from '@forge-fr/http';
import { AuthServiceToken, type AuthService } from './auth.service.ts';

const middlewareByService = new WeakMap<AuthService, ForgeMiddleware>();

/**
 * DI-aware ForgeJS authentication middleware.
 * Resolves AuthService from the request's scoped container at runtime so controllers stay pure.
 */
export const requireBearerAuth: ForgeMiddleware = (ctx, next) => {
  const authService = ctx.resolve(AuthServiceToken);
  let middleware = middlewareByService.get(authService);
  if (!middleware) {
    middleware = createAuthMiddleware(authService.authMiddlewareOptions);
    middlewareByService.set(authService, middleware);
  }
  return middleware(ctx, next);
};
