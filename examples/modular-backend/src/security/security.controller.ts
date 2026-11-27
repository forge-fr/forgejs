import { requireAuth } from '@forge-fr/auth';
import type { ForgeHttpApp, ForgeMiddleware } from '@forge-fr/http';
import { validatedOpenApiHandler } from '@forge-fr/openapi';
import { createCsrfMiddleware, createRateLimitMiddleware } from '@forge-fr/security';
import { z } from 'zod';
import { requireBearerAuth } from '../auth/auth.middleware.ts';
import {
  DEMO_RATE_LIMIT_MAX,
  DEMO_RATE_LIMIT_WINDOW_MS,
  SecurityServiceToken,
  type SecurityService,
} from './security.service.ts';

const rateLimiterByService = new WeakMap<SecurityService, ForgeMiddleware>();

const demoRateLimitMiddleware: ForgeMiddleware = (ctx, next) => {
  const security = ctx.resolve(SecurityServiceToken);
  let limiter = rateLimiterByService.get(security);
  if (!limiter) {
    limiter = createRateLimitMiddleware({
      store: security.demoRateLimitStore,
      max: DEMO_RATE_LIMIT_MAX,
      windowMs: DEMO_RATE_LIMIT_WINDOW_MS,
      keyGenerator: (reqCtx) => {
        const identity = requireAuth(reqCtx);
        return `lab:${identity.tenantId ?? 'anon'}:${identity.subject}`;
      },
      message: `Security Lab rate limit exceeded (${DEMO_RATE_LIMIT_MAX} requests per ${DEMO_RATE_LIMIT_WINDOW_MS / 1000}s window)`,
    });
    rateLimiterByService.set(security, limiter);
  }
  return limiter(ctx, next);
};

const demoCsrfMiddleware: ForgeMiddleware = (ctx, next) => {
  const security = ctx.resolve(SecurityServiceToken);
  const httpOrigin = ctx.url.origin;
  const httpsOrigin = httpOrigin.replace(/^http:/, 'https:');
  const middleware = createCsrfMiddleware({
    headerName: 'x-csrf-token',
    enforceFetchMetadata: true,
    allowedOrigins: [httpOrigin, httpsOrigin],
    getExpectedToken: (reqCtx) => {
      const identity = requireAuth(reqCtx);
      return security.getExpectedCsrfToken(identity);
    },
  });
  return middleware(ctx, next);
};

const PathProbeBodySchema = z.object({
  path: z.string().min(1).max(300),
});

export function registerSecurityController(app: ForgeHttpApp): void {
  app.group('/playground-api/security', (group) => {
    group.get(
      '/rate-limit-probe',
      validatedOpenApiHandler(
        {},
        (ctx) => {
          const identity = requireAuth(ctx);
          return ctx.json({
            allowed: true,
            policy: {
              max: DEMO_RATE_LIMIT_MAX,
              windowMs: DEMO_RATE_LIMIT_WINDOW_MS,
              key: `lab:${identity.tenantId ?? 'anon'}:${identity.subject}`,
            },
            timestamp: new Date().toISOString(),
          });
        },
        {
          summary: 'Probe endpoint protected by @forge-fr/security createRateLimitMiddleware (3 req / 15s)',
          tags: ['Security'],
        },
      ),
      { middleware: [requireBearerAuth, demoRateLimitMiddleware] },
    );

    group.post(
      '/rate-limit-reset',
      validatedOpenApiHandler(
        {},
        (ctx) => {
          requireAuth(ctx);
          const security = ctx.resolve(SecurityServiceToken);
          security.resetDemoRateLimit();
          return ctx.json({
            reset: true,
            max: DEMO_RATE_LIMIT_MAX,
            windowMs: DEMO_RATE_LIMIT_WINDOW_MS,
          });
        },
        {
          summary: 'Reset the Security Lab demo rate-limiter window immediately',
          tags: ['Security'],
        },
      ),
      { middleware: [requireBearerAuth] },
    );

    group.get(
      '/csrf-token',
      validatedOpenApiHandler(
        {},
        (ctx) => {
          const identity = requireAuth(ctx);
          const security = ctx.resolve(SecurityServiceToken);
          const csrfToken = security.issueCsrfToken(identity);
          return ctx.json({
            csrfToken,
            headerName: 'X-CSRF-Token',
          });
        },
        {
          summary: 'Issue a synchronizer CSRF token via @forge-fr/security generateCsrfToken()',
          tags: ['Security'],
        },
      ),
      { middleware: [requireBearerAuth] },
    );

    group.post(
      '/csrf-probe',
      validatedOpenApiHandler(
        {},
        (ctx) => {
          requireAuth(ctx);
          return ctx.json({
            accepted: true,
            guard: '@forge-fr/security createCsrfMiddleware',
            timestamp: new Date().toISOString(),
          });
        },
        {
          summary: 'State-mutating probe guarded by createCsrfMiddleware (requires valid X-CSRF-Token)',
          tags: ['Security'],
        },
      ),
      { middleware: [requireBearerAuth, demoCsrfMiddleware] },
    );

    group.post(
      '/sanitize-probe',
      validatedOpenApiHandler(
        {},
        async (ctx) => {
          requireAuth(ctx);
          const security = ctx.resolve(SecurityServiceToken);
          const rawBody = await ctx.body.text();
          return ctx.json(security.probePrototypePollution(rawBody));
        },
        {
          summary: 'Parse untrusted JSON via safeJsonParse() to strip __proto__/constructor/prototype keys',
          tags: ['Security'],
        },
      ),
      { middleware: [requireBearerAuth] },
    );

    group.post(
      '/path-probe',
      validatedOpenApiHandler(
        { body: PathProbeBodySchema },
        (ctx, { body }) => {
          requireAuth(ctx);
          const security = ctx.resolve(SecurityServiceToken);
          return ctx.json(security.probePathConfinement(body.path));
        },
        {
          summary: 'Test path traversal confinement via @forge-fr/security resolveConfinedPath()',
          tags: ['Security'],
        },
      ),
      { middleware: [requireBearerAuth] },
    );
  });
}
