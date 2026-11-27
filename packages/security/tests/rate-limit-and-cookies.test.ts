import { describe, expect, it } from 'vitest';
import { ConfigurationError } from '@forge-fr/core';
import { createHttpApp } from '@forge-fr/http';
import { createTestClient } from '@forge-fr/testing';
import {
  createMemoryRateLimitStore,
  createRateLimitMiddleware,
  extractClientIp,
  serializeHardenedCookie,
} from '@forge-fr/security';

describe('@forge-fr/security Rate Limiting & Hardened Cookies (M5.1)', () => {
  it('throttles bursts with 429 + Retry-After and ignores spoofed X-Forwarded-For unless trustProxy is enabled', async () => {
    let now = 1_700_000_000_000;
    const store = createMemoryRateLimitStore({ maxKeys: 100, now: () => now });

    const app = createHttpApp();
    app.use(
      createRateLimitMiddleware({
        store,
        max: 2,
        windowMs: 60_000,
        trustProxy: false,
      }),
    );
    app.get('/api', (ctx) => ctx.json({ ip: extractClientIp(ctx, { trustProxy: false }) }));

    const client = createTestClient(app);

    // 1st and 2nd request from same remoteAddress succeed even if attacker rotates X-Forwarded-For!
    const r1 = await client.get('/api', {
      remoteAddress: '198.51.100.10',
      headers: { 'x-forwarded-for': '1.1.1.1' },
    });
    expect(r1.status).toBe(200);
    expect(r1.header('ratelimit-limit')).toBe('2');
    expect(r1.header('ratelimit-remaining')).toBe('1');
    expect(await r1.json()).toEqual({ ip: '198.51.100.10' });

    const r2 = await client.get('/api', {
      remoteAddress: '198.51.100.10',
      headers: { 'x-forwarded-for': '2.2.2.2' },
    });
    expect(r2.status).toBe(200);
    expect(r2.header('ratelimit-remaining')).toBe('0');

    // 3rd request with ANOTHER spoofed X-Forwarded-For MUST STILL BE THROTTLED (429 + Retry-After)!
    const r3 = await client.get('/api', {
      remoteAddress: '198.51.100.10',
      headers: { 'x-forwarded-for': '3.3.3.3' },
    });
    expect(r3.status).toBe(429);
    expect(Number(r3.header('retry-after'))).toBeGreaterThan(0);

    // Different real remote IP is unaffected
    const otherIp = await client.get('/api', { remoteAddress: '203.0.113.42' });
    expect(otherIp.status).toBe(200);

    // After window expires, limit resets cleanly
    now += 61_000;
    const afterReset = await client.get('/api', { remoteAddress: '198.51.100.10' });
    expect(afterReset.status).toBe(200);

    await client.close();
  });

  it('extracts rightmost untrusted client IP when trustProxy hops are configured', async () => {
    const app = createHttpApp();
    app.get('/ip', (ctx) =>
      ctx.json({
        ip: extractClientIp(ctx, { trustProxy: true, trustedProxyHops: 1 }),
      }),
    );

    const client = createTestClient(app);
    // Client sent spoofed "9.9.9.9", then 1 trusted reverse proxy appended real client "203.0.113.77"
    const res = await client.get('/ip', {
      remoteAddress: '10.0.0.5',
      headers: { 'x-forwarded-for': '9.9.9.9, 203.0.113.77' },
    });
    expect(await res.json()).toEqual({ ip: '203.0.113.77' });
    await client.close();
  });

  it('enforces hardened cookie defaults, __Host-/__Secure- invariants, and rejects CRLF injection', () => {
    const cookie = serializeHardenedCookie('__Host-session', 'abc123', {
      maxAgeSeconds: 3600,
    });
    expect(cookie).toContain('__Host-session=abc123');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Path=/');
    expect(cookie).toContain('Max-Age=3600');

    // __Host- rejects Domain or non-root Path or Secure=false
    expect(() =>
      serializeHardenedCookie('__Host-session', 'abc', { domain: 'example.com' }),
    ).toThrow(ConfigurationError);
    expect(() =>
      serializeHardenedCookie('__Host-session', 'abc', { path: '/admin' }),
    ).toThrow(ConfigurationError);
    expect(() =>
      serializeHardenedCookie('__Host-session', 'abc', { secure: false }),
    ).toThrow(ConfigurationError);

    // __Secure- requires Secure=true
    expect(() =>
      serializeHardenedCookie('__Secure-token', 'xyz', { secure: false }),
    ).toThrow(ConfigurationError);

    // SameSite=None requires Secure=true
    expect(() =>
      serializeHardenedCookie('sid', 'xyz', { sameSite: 'None', secure: false }),
    ).toThrow(ConfigurationError);

    // CRLF header injection rejected
    expect(() => serializeHardenedCookie('sid', 'val\r\nSet-Cookie: evil=1')).toThrow(
      ConfigurationError,
    );
  });
});
