import { describe, expect, it } from 'vitest';
import { ConfigurationError, ForgeError } from '@forge-fr/core';
import { createHttpApp } from '@forge-fr/http';
import { createTestClient } from '@forge-fr/testing';
import {
  buildCspHeader,
  createCorsMiddleware,
  createCsrfMiddleware,
  createSecurityHeadersMiddleware,
  generateCsrfToken,
} from '@forge-fr/security';

describe('@forge-fr/security Headers, Strict CORS & CSRF (M5.1)', () => {
  it('applies hardened default security headers and CSP on both normal and error responses', async () => {
    const app = createHttpApp();
    const csp = buildCspHeader({
      'default-src': ["'self'"],
      'object-src': ["'none'"],
      'frame-ancestors': ["'none'"],
    });

    app.use(
      createSecurityHeadersMiddleware({
        contentSecurityPolicy: csp,
        hsts: { maxAgeSeconds: 31536000, includeSubDomains: true },
      }),
    );

    app.get('/ok', (ctx) => {
      ctx.setHeader('x-powered-by', 'leaky-server');
      return ctx.json({ ok: true });
    });

    app.get('/fail', () => {
      throw new ForgeError('Boom', { statusCode: 500, code: 'BOOM', expose: false });
    });

    const client = createTestClient(app, { baseUrl: 'https://api.example.com' });

    const okRes = await client.get('/ok');
    expect(okRes.status).toBe(200);
    expect(okRes.header('x-content-type-options')).toBe('nosniff');
    expect(okRes.header('x-frame-options')).toBe('DENY');
    expect(okRes.header('referrer-policy')).toBe('no-referrer');
    expect(okRes.header('cross-origin-opener-policy')).toBe('same-origin');
    expect(okRes.header('cross-origin-resource-policy')).toBe('same-origin');
    expect(okRes.header('permissions-policy')).toContain('camera=()');
    expect(okRes.header('content-security-policy')).toBe(
      "default-src 'self'; object-src 'none'; frame-ancestors 'none'",
    );
    expect(okRes.header('strict-transport-security')).toBe('max-age=31536000; includeSubDomains');
    expect(okRes.header('x-powered-by')).toBeNull();

    // SECURITY (OWASP ASVS): error responses MUST also carry hardened headers
    const errRes = await client.get('/fail');
    expect(errRes.status).toBe(500);
    expect(errRes.header('x-content-type-options')).toBe('nosniff');
    expect(errRes.header('x-frame-options')).toBe('DENY');
    expect(errRes.header('referrer-policy')).toBe('no-referrer');

    await client.close();
  });

  it('throws startup ConfigurationError on wildcard CORS + credentials and blocks disallowed/null origins', async () => {
    // SECURITY REGRESSION: wildcard + credentials MUST be fatal at boot time
    expect(() =>
      createCorsMiddleware({
        origin: '*',
        credentials: true,
      }),
    ).toThrow(ConfigurationError);

    expect(() =>
      createCorsMiddleware({
        origin: ['https://app.example.com', '*'],
        credentials: true,
      }),
    ).toThrow(ConfigurationError);

    const app = createHttpApp();
    app.use(
      createCorsMiddleware({
        origin: ['https://app.example.com'],
        credentials: true,
        methods: ['GET', 'POST'],
        allowedHeaders: ['Content-Type', 'Authorization'],
        maxAgeSeconds: 600,
      }),
    );
    app.get('/data', (ctx) => ctx.json({ secret: false }));
    app.options('/data', (ctx) => ctx.empty(204));

    const client = createTestClient(app);

    // Allowed origin receives exact echo + Vary: Origin + credentials
    const allowed = await client.get('/data', {
      headers: { origin: 'https://app.example.com' },
    });
    expect(allowed.status).toBe(200);
    expect(allowed.header('access-control-allow-origin')).toBe('https://app.example.com');
    expect(allowed.header('access-control-allow-credentials')).toBe('true');
    expect(allowed.header('vary')).toContain('Origin');

    // Disallowed evil origin and 'null' origin MUST NOT receive ACAO header
    const evil = await client.get('/data', {
      headers: { origin: 'https://evil.attacker.test' },
    });
    expect(evil.header('access-control-allow-origin')).toBeNull();

    const nullOrigin = await client.get('/data', {
      headers: { origin: 'null' },
    });
    expect(nullOrigin.header('access-control-allow-origin')).toBeNull();

    // Preflight OPTIONS for allowed origin
    const preflight = await client.options('/data', {
      headers: {
        origin: 'https://app.example.com',
        'access-control-request-method': 'POST',
      },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.header('access-control-allow-origin')).toBe('https://app.example.com');
    expect(preflight.header('access-control-allow-methods')).toContain('POST');
    expect(preflight.header('access-control-max-age')).toBe('600');

    // Preflight for disallowed origin rejected cleanly with 403
    const badPreflight = await client.options('/data', {
      headers: {
        origin: 'https://evil.attacker.test',
        'access-control-request-method': 'POST',
      },
    });
    expect(badPreflight.status).toBe(403);
    expect(badPreflight.header('access-control-allow-origin')).toBeNull();

    await client.close();
  });

  it('blocks cross-site state mutations and mismatched CSRF double-submit tokens while permitting valid tokens', async () => {
    const app = createHttpApp();
    app.use(
      createCsrfMiddleware({
        allowedOrigins: ['https://app.example.com'],
      }),
    );

    app.get('/csrf-token', (ctx) => {
      const token = generateCsrfToken();
      return ctx.json({ token });
    });

    app.post('/transfer', (ctx) => ctx.json({ transferred: true }));

    const client = createTestClient(app, { baseUrl: 'https://app.example.com' });

    // Safe GET bypasses CSRF token check
    const tokenRes = await client.get('/csrf-token');
    expect(tokenRes.status).toBe(200);
    const { token } = await tokenRes.json<{ token: string }>();
    expect(token.length).toBeGreaterThanOrEqual(40);

    // 1. Missing CSRF token on POST -> 403
    const missing = await client.post('/transfer', {
      headers: { origin: 'https://app.example.com' },
    });
    expect(missing.status).toBe(403);

    // 2. Cross-site Origin on POST even with matching tokens -> 403
    const crossOrigin = await client.post('/transfer', {
      headers: {
        origin: 'https://evil.example.net',
        cookie: `__Host-forge_csrf=${token}`,
        'x-csrf-token': token,
      },
    });
    expect(crossOrigin.status).toBe(403);

    // 3. Sec-Fetch-Site: cross-site -> 403
    const crossFetchSite = await client.post('/transfer', {
      headers: {
        'sec-fetch-site': 'cross-site',
        cookie: `__Host-forge_csrf=${token}`,
        'x-csrf-token': token,
      },
    });
    expect(crossFetchSite.status).toBe(403);

    // 4. Mismatched double-submit token -> 403
    const mismatched = await client.post('/transfer', {
      headers: {
        origin: 'https://app.example.com',
        cookie: `__Host-forge_csrf=${token}`,
        'x-csrf-token': 'wrong-token-value',
      },
    });
    expect(mismatched.status).toBe(403);

    // 5. Valid same-origin + matching cookie & header token -> 200
    const valid = await client.post('/transfer', {
      headers: {
        origin: 'https://app.example.com',
        'sec-fetch-site': 'same-origin',
        cookie: `__Host-forge_csrf=${token}`,
        'x-csrf-token': token,
      },
    });
    expect(valid.status).toBe(200);
    expect(await valid.json()).toEqual({ transferred: true });

    await client.close();
  });
});
