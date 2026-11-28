import { parseCookies, requireAuth } from '@forge-fr/auth';
import type { ForgeHttpApp } from '@forge-fr/http';
import { validatedOpenApiHandler } from '@forge-fr/openapi';
import { z } from 'zod';
import { requireBearerAuth } from './auth.middleware.ts';
import { AuthServiceToken } from './auth.service.ts';

const RegisterBodySchema = z.object({
  email: z.string().email().max(120),
  password: z.string().min(8).max(128),
  name: z.string().trim().min(2).max(80),
  tenantName: z.string().trim().min(2).max(80).optional(),
  role: z.enum(['admin', 'member']).default('admin'),
});

const LoginBodySchema = z.object({
  email: z.string().email().max(120),
  password: z.string().min(1).max(128),
});

const CreateApiKeyBodySchema = z.object({
  name: z.string().trim().min(2).max(60),
  scopes: z
    .array(
      z.enum([
        'tasks:read',
        'tasks:create',
        'tasks:update',
        'tasks:delete',
        'webhooks:read',
        'attachments:read',
      ]),
    )
    .min(1)
    .max(6),
  expiresInSeconds: z.number().int().min(60).max(86_400).optional(),
});

const GenerateOAuthPkceBodySchema = z.object({
  redirectUri: z
    .enum(['http://localhost:3000/playground', 'https://playground.forgejs.id/callback'])
    .default('http://localhost:3000/playground'),
  scopes: z.array(z.string().min(1).max(40)).min(1).max(6).default(['openid', 'profile', 'tasks:read']),
});

const VerifyOAuthStateBodySchema = z.object({
  stateId: z.string().min(1),
  receivedState: z.string().min(1),
});

export function registerAuthController(app: ForgeHttpApp): void {
  app.group('/playground-api/auth', (group) => {
    group.post(
      '/register',
      validatedOpenApiHandler(
        { body: RegisterBodySchema },
        async (ctx, { body }) => {
          const auth = ctx.resolve(AuthServiceToken);
          const session = await auth.register(body);
          return ctx.json(session, { status: 201 });
        },
        {
          summary: 'Register a new user with Argon2id password hashing and HS256 JWT issuance',
          tags: ['Auth'],
        },
      ),
    );

    group.post(
      '/login',
      validatedOpenApiHandler(
        { body: LoginBodySchema },
        async (ctx, { body }) => {
          const auth = ctx.resolve(AuthServiceToken);
          const session = await auth.login(body);
          return ctx.json(session);
        },
        {
          summary: 'Sign in with Argon2id password verification and receive an HS256 Bearer JWT',
          tags: ['Auth'],
        },
      ),
    );

    group.get(
      '/me',
      validatedOpenApiHandler(
        {},
        (ctx) => {
          const identity = requireAuth(ctx);
          const auth = ctx.resolve(AuthServiceToken);
          return ctx.json(auth.me(identity));
        },
        {
          summary: 'Inspect the authenticated ForgeJS AuthIdentity (JWT, X-API-Key, or Session Cookie)',
          tags: ['Auth'],
        },
      ),
      { middleware: [requireBearerAuth] },
    );

    // Scoped API Key Lifecycle (@forge-fr/auth createApiKeyManager + createApiKeyAuthStrategy)
    group.get(
      '/api-keys',
      validatedOpenApiHandler(
        {},
        (ctx) => {
          const identity = requireAuth(ctx);
          const auth = ctx.resolve(AuthServiceToken);
          return ctx.json({ keys: auth.listApiKeys(identity) });
        },
        {
          summary: 'List tenant API key metadata summaries (hashed secrets are never exposed)',
          tags: ['Auth'],
        },
      ),
      { middleware: [requireBearerAuth] },
    );

    group.post(
      '/api-keys',
      validatedOpenApiHandler(
        { body: CreateApiKeyBodySchema },
        async (ctx, { body }) => {
          const identity = requireAuth(ctx);
          const auth = ctx.resolve(AuthServiceToken);
          const issued = await auth.createApiKey(identity, {
            name: body.name,
            scopes: body.scopes,
            ...(body.expiresInSeconds !== undefined ? { expiresInSeconds: body.expiresInSeconds } : {}),
          });
          return ctx.json(issued, { status: 201 });
        },
        {
          summary: 'Mint a tenant-scoped SHA-256 hashed API key (fjs_key_...)',
          tags: ['Auth'],
        },
      ),
      { middleware: [requireBearerAuth] },
    );

    group.delete(
      '/api-keys/:id',
      validatedOpenApiHandler(
        {},
        async (ctx) => {
          const identity = requireAuth(ctx);
          const auth = ctx.resolve(AuthServiceToken);
          const key = await auth.revokeApiKey(identity, ctx.params['id'] ?? '');
          return ctx.json({ revoked: true, key });
        },
        {
          summary: 'Revoke an issued API key immediately with tenant isolation checks',
          tags: ['Auth'],
        },
      ),
      { middleware: [requireBearerAuth] },
    );

    // HttpOnly Cookie Session Management (@forge-fr/auth createSessionManager)
    group.post(
      '/session/login',
      validatedOpenApiHandler(
        {},
        async (ctx) => {
          const identity = requireAuth(ctx);
          const auth = ctx.resolve(AuthServiceToken);
          const result = await auth.createCookieSession(identity);
          ctx.appendHeader('set-cookie', result.setCookieHeader);
          return ctx.json({
            issued: true,
            cookieName: result.cookieName,
            setCookieHeader: result.setCookieHeader,
            sessionToken: result.sessionToken,
            expiresAt: result.expiresAt,
            user: result.user,
            tenant: result.tenant,
          });
        },
        {
          summary: 'Mint a sliding HttpOnly + Partitioned session cookie via createSessionManager',
          tags: ['Auth'],
        },
      ),
      { middleware: [requireBearerAuth] },
    );

    group.get(
      '/session/verify',
      validatedOpenApiHandler(
        {},
        (ctx) => {
          const identity = requireAuth(ctx);
          const auth = ctx.resolve(AuthServiceToken);
          return ctx.json({
            authenticated: true,
            method: identity.method,
            ...auth.me(identity),
          });
        },
        {
          summary: 'Verify session cookie authentication via createSessionAuthStrategy',
          tags: ['Auth'],
        },
      ),
      { middleware: [requireBearerAuth] },
    );

    group.post(
      '/session/logout',
      validatedOpenApiHandler(
        {},
        async (ctx) => {
          const auth = ctx.resolve(AuthServiceToken);
          const cookies = parseCookies(ctx.request.headers.get('cookie'));
          const clearHeader = await auth.clearCookieSession(cookies[auth.sessionManager.cookieName]);
          ctx.appendHeader('set-cookie', clearHeader);
          return ctx.json({ cleared: true, cookieName: auth.sessionManager.cookieName });
        },
        {
          summary: 'Revoke active session cookie and emit Max-Age=0 Set-Cookie header',
          tags: ['Auth'],
        },
      ),
    );

    // OAuth2 + PKCE Generator & State Verifier (@forge-fr/auth)
    group.post(
      '/oauth/pkce',
      validatedOpenApiHandler(
        { body: GenerateOAuthPkceBodySchema },
        async (ctx, { body }) => {
          const identity = requireAuth(ctx);
          const auth = ctx.resolve(AuthServiceToken);
          const bundle = await auth.generateOAuthPkce(identity, body);
          return ctx.json(bundle);
        },
        {
          summary: 'Generate S256 PKCE challenge, CSPRNG state/nonce, and validated authorization URL',
          tags: ['Auth'],
        },
      ),
      { middleware: [requireBearerAuth] },
    );

    group.post(
      '/oauth/verify-state',
      validatedOpenApiHandler(
        { body: VerifyOAuthStateBodySchema },
        (ctx, { body }) => {
          requireAuth(ctx);
          const auth = ctx.resolve(AuthServiceToken);
          return ctx.json(auth.verifyOAuthState(body.stateId, body.receivedState));
        },
        {
          summary: 'Verify OAuth2 callback state in constant time via verifyOAuthCallbackState',
          tags: ['Auth'],
        },
      ),
      { middleware: [requireBearerAuth] },
    );
  });
}
