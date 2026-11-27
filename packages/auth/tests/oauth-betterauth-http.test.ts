import { describe, expect, it } from 'vitest';
import { SignJWT, generateKeyPair } from 'jose';
import { ConfigurationError, UnauthorizedError, secret } from '@forge-fr/core';
import { createHttpApp } from '@forge-fr/http';
import { createPluginTestHarness, createTestClient } from '@forge-fr/testing';
import {
  AuthTokens,
  buildAuthorizationUrl,
  createApiKeyAuthStrategy,
  createApiKeyManager,
  createAuthMiddleware,
  createAuthPlugin,
  createBetterAuthStrategy,
  createJwtAuthStrategy,
  createJwtService,
  createMemoryApiKeyStore,
  createMemorySessionStore,
  createOAuthState,
  createPkceChallenge,
  createSessionAuthStrategy,
  createSessionManager,
  getAuth,
  mountBetterAuth,
  requireAuth,
  verifyOAuthCallbackState,
  verifyOidcIdToken,
  type BetterAuthInstanceLike,
} from '../src/index.js';

describe('@forge-fr/auth OAuth 2.0/OIDC, Better Auth, HTTP Middleware & ForgeJS Plugin (M4.3)', () => {
  it('generates PKCE S256 challenges, validates redirectUri allowlists, checks state CSRF, and verifies OIDC id_tokens', async () => {
    const pkce = await createPkceChallenge();
    expect(pkce.method).toBe('S256');
    expect(pkce.codeVerifier.length).toBeGreaterThanOrEqual(43);
    expect(pkce.codeChallenge.length).toBeGreaterThanOrEqual(43);
    expect(pkce.codeChallenge).not.toBe(pkce.codeVerifier);

    const { state, nonce } = createOAuthState();
    expect(state.length).toBeGreaterThanOrEqual(40);
    expect(nonce.length).toBeGreaterThanOrEqual(40);

    const authUrl = buildAuthorizationUrl({
      authorizationEndpoint: 'https://accounts.example.com/oauth2/authorize',
      clientId: 'forge_client_1',
      redirectUri: 'https://app.forgejs.dev/auth/callback',
      allowedRedirectUris: ['https://app.forgejs.dev/auth/callback'],
      scopes: ['openid', 'profile', 'email'],
      state,
      nonce,
      pkce,
    });
    const parsed = new URL(authUrl);
    expect(parsed.searchParams.get('response_type')).toBe('code');
    expect(parsed.searchParams.get('code_challenge_method')).toBe('S256');
    expect(parsed.searchParams.get('code_challenge')).toBe(pkce.codeChallenge);
    expect(parsed.searchParams.get('state')).toBe(state);
    expect(parsed.searchParams.get('nonce')).toBe(nonce);

    // Block open redirect / unallowlisted redirectUri & dangerous schemes
    expect(() =>
      buildAuthorizationUrl({
        authorizationEndpoint: 'https://accounts.example.com/oauth2/authorize',
        clientId: 'forge_client_1',
        redirectUri: 'https://evil.attacker.example/steal',
        allowedRedirectUris: ['https://app.forgejs.dev/auth/callback'],
        state,
        pkce,
      }),
    ).toThrow(ConfigurationError);

    expect(() =>
      buildAuthorizationUrl({
        authorizationEndpoint: 'javascript:alert(1)',
        clientId: 'forge_client_1',
        redirectUri: 'https://app.forgejs.dev/auth/callback',
        allowedRedirectUris: ['https://app.forgejs.dev/auth/callback'],
        state,
        pkce,
      }),
    ).toThrow(ConfigurationError);

    // Constant-time state verification
    expect(() => verifyOAuthCallbackState(state, state)).not.toThrow();
    expect(() => verifyOAuthCallbackState(state, 'forged-state')).toThrow(UnauthorizedError);

    // Real ES256 OIDC id_token verification with nonce check
    const { privateKey, publicKey } = await generateKeyPair('ES256');
    const idToken = await new SignJWT({ email: 'dev@forgejs.dev', nonce })
      .setProtectedHeader({ alg: 'ES256' })
      .setIssuer('https://accounts.example.com')
      .setAudience('forge_client_1')
      .setSubject('oidc_user_99')
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(privateKey);

    const oidcResult = await verifyOidcIdToken(idToken, {
      issuer: 'https://accounts.example.com',
      clientId: 'forge_client_1',
      algorithms: ['ES256'],
      key: publicKey,
      expectedNonce: nonce,
    });
    expect(oidcResult.subject).toBe('oidc_user_99');
    expect(oidcResult.claims['email']).toBe('dev@forgejs.dev');

    // Reject nonce mismatch
    await expect(
      verifyOidcIdToken(idToken, {
        issuer: 'https://accounts.example.com',
        clientId: 'forge_client_1',
        algorithms: ['ES256'],
        key: publicKey,
        expectedNonce: 'wrong-nonce',
      }),
    ).rejects.toThrow(UnauthorizedError);
  });

  it('authenticates ForgeJS HTTP routes across Session, Bearer JWT, API Key, and Better Auth strategies', async () => {
    const jwt = createJwtService({
      algorithms: ['HS256'],
      secret: secret('forgejs-multi-strategy-jwt-secret-key-at-least-32-bytes'),
      issuer: 'forge-auth',
      audience: 'forge-app',
    });
    const sessions = createSessionManager({ store: createMemorySessionStore() });
    const apiKeys = createApiKeyManager({ store: createMemoryApiKeyStore() });

    const fakeBetterAuth: BetterAuthInstanceLike = {
      async handler(request: Request) {
        const url = new URL(request.url);
        return Response.json({ handledBy: 'better-auth', path: url.pathname });
      },
      api: {
        async getSession({ headers }) {
          if (headers.get('x-better-auth-token') === 'valid-ba-session') {
            return {
              user: { id: 'ba_user_7', role: 'editor' },
              session: { id: 'ba_sess_7' },
            };
          }
          return null;
        },
      },
    };

    const app = createHttpApp();
    mountBetterAuth(app, fakeBetterAuth, '/api/auth');

    const requireAuthMw = createAuthMiddleware({
      strategies: [
        createSessionAuthStrategy(sessions),
        createJwtAuthStrategy(jwt),
        createApiKeyAuthStrategy(apiKeys),
        createBetterAuthStrategy(fakeBetterAuth),
      ],
    });

    app.get('/protected', (ctx) => {
      const identity = requireAuth(ctx);
      return ctx.json({ subject: identity.subject, method: identity.method, roles: identity.roles });
    }, { middleware: [requireAuthMw] });

    app.get('/optional', (ctx) => {
      const identity = getAuth(ctx);
      return ctx.json({ authenticated: identity !== undefined, subject: identity?.subject ?? null });
    }, {
      middleware: [
        createAuthMiddleware({
          strategies: [createJwtAuthStrategy(jwt)],
          optional: true,
        }),
      ],
    });

    const client = createTestClient(app);

    // 1. Better Auth mounted route works directly
    const baRes = await client.get('/api/auth/session');
    expect(baRes.status).toBe(200);
    expect(await baRes.json()).toEqual({ handledBy: 'better-auth', path: '/api/auth/session' });

    // 2. Unauthenticated request rejected with 401
    const unauth = await client.get('/protected');
    expect(unauth.status).toBe(401);

    // 3. Optional route succeeds cleanly without credentials
    const optRes = await client.get('/optional');
    expect(optRes.status).toBe(200);
    expect(await optRes.json()).toEqual({ authenticated: false, subject: null });

    // 4. Session cookie authentication
    const sess = await sessions.create('usr_session', { roles: ['member'] });
    const sessRes = await client.get('/protected', {
      headers: { cookie: `forge_session=${sess.sessionId}` },
    });
    expect(sessRes.status).toBe(200);
    expect(await sessRes.json()).toEqual({
      subject: 'usr_session',
      method: 'session',
      roles: ['member'],
    });

    // 5. Bearer JWT authentication
    const bearer = await jwt.sign({ sub: 'usr_jwt', roles: ['admin'] });
    const jwtRes = await client.get('/protected', {
      headers: { authorization: `Bearer ${bearer}` },
    });
    expect(jwtRes.status).toBe(200);
    expect(await jwtRes.json()).toEqual({
      subject: 'usr_jwt',
      method: 'jwt',
      roles: ['admin'],
    });

    // 6. API Key authentication
    const key = await apiKeys.create({ subject: 'svc_worker', name: 'Worker', scopes: ['jobs:run'] });
    const keyRes = await client.get('/protected', {
      headers: { 'x-api-key': key.apiKey },
    });
    expect(keyRes.status).toBe(200);
    expect(await keyRes.json()).toEqual({
      subject: 'svc_worker',
      method: 'api_key',
      roles: [],
    });

    // 7. Better Auth strategy authentication
    const baAuthRes = await client.get('/protected', {
      headers: { 'x-better-auth-token': 'valid-ba-session' },
    });
    expect(baAuthRes.status).toBe(200);
    expect(await baAuthRes.json()).toEqual({
      subject: 'ba_user_7',
      method: 'better_auth',
      roles: ['editor'],
    });

    await client.close();
  });

  it('registers and exports auth primitives via ForgeJS plugin DI tokens', async () => {
    const plugin = createAuthPlugin();
    const harness = createPluginTestHarness({
      plugin,
      config: {
        jwt: {
          algorithms: ['HS256'],
          secret: secret('forgejs-plugin-test-jwt-secret-key-at-least-32-bytes'),
          issuer: 'forge-plugin',
          audience: 'forge-clients',
        },
        sessions: {
          store: createMemorySessionStore(),
        },
        apiKeys: {
          store: createMemoryApiKeyStore(),
        },
      },
    });

    await harness.start();
    const passwordHasher = harness.resolveExport(AuthTokens.passwordHasher);
    const jwtService = harness.resolveExport(AuthTokens.jwt);
    const sessionManager = harness.resolveExport(AuthTokens.sessions);
    const apiKeyManager = harness.resolveExport(AuthTokens.apiKeys);

    const hash = await passwordHasher.hash('Plugin-Password-2026!');
    expect(await passwordHasher.verify('Plugin-Password-2026!', hash)).toBe(true);

    const token = await jwtService.sign({ sub: 'plugin_user' });
    const verified = await jwtService.verify(token);
    expect(verified.payload.sub).toBe('plugin_user');

    const sess = await sessionManager.create('plugin_user');
    expect((await sessionManager.verify(sess.sessionId))?.subject).toBe('plugin_user');

    const apiKey = await apiKeyManager.create({ subject: 'plugin_svc', name: 'Test' });
    expect((await apiKeyManager.verify(apiKey.apiKey))?.subject).toBe('plugin_svc');

    await harness.dispose();
  });
});
