import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { createPluginTestHarness } from '@forge-fr/testing';
import {
  PathTraversalError,
  SecurityTokens,
  SsrfBlockedError,
  createSafeFetch,
  createSecurityPlugin,
  isPrivateOrReservedIp,
  resolveConfinedPath,
  safeJsonParse,
  sanitizeFilename,
  sanitizeObject,
  validateOutboundUrl,
} from '@forge-fr/security';

describe('@forge-fr/security Prototype Pollution, Path Traversal, SSRF & Plugin (M5.1)', () => {
  it('neutralizes prototype pollution payloads across nested objects, safeJsonParse, and fuzz vectors', () => {
    const rawJson = '{"safe":"ok","__proto__":{"polluted":true},"nested":{"constructor":{"prototype":{"admin":true}}}}';
    const parsed = safeJsonParse<Record<string, unknown>>(rawJson);

    expect(parsed['safe']).toBe('ok');
    expect(Object.prototype.hasOwnProperty.call(parsed, '__proto__')).toBe(false);
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
    expect(({} as Record<string, unknown>)['admin']).toBeUndefined();

    const nested = parsed['nested'] as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(nested, 'constructor')).toBe(false);

    // Property-based fuzz test ensuring sanitizeObject never pollutes Object.prototype
    fc.assert(
      fc.property(
        fc.dictionary(
          fc.oneof(fc.constant('__proto__'), fc.constant('constructor'), fc.constant('prototype'), fc.string()),
          fc.jsonValue(),
        ),
        (input) => {
          const cleaned = sanitizeObject(input) as Record<string, unknown>;
          expect(Object.getPrototypeOf(cleaned)).toBeNull();
          expect(Object.prototype.hasOwnProperty.call(cleaned, '__proto__')).toBe(false);
          expect(Object.prototype.hasOwnProperty.call(cleaned, 'constructor')).toBe(false);
          expect(Object.prototype.hasOwnProperty.call(cleaned, 'prototype')).toBe(false);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('blocks path traversal vectors (../, %2e%2e, double-encoded, null bytes, backslashes) and sanitizes filenames', () => {
    expect(resolveConfinedPath('/var/app/uploads', 'avatars/user-1.png')).toBe(
      '/var/app/uploads/avatars/user-1.png',
    );

    const traversalVectors = [
      '../etc/passwd',
      'a/../../etc/passwd',
      '%2e%2e/secret.env',
      '%252e%252e/%252e%252e/etc/passwd',
      '..\\windows\\system32\\config',
      '/etc/passwd',
      'C:\\Windows\\win.ini',
      'good/file.txt\u0000.png',
    ];

    for (const vec of traversalVectors) {
      expect(() => resolveConfinedPath('/var/app/uploads', vec)).toThrow(PathTraversalError);
    }

    // Sibling prefix bypass check (/var/app/uploads2 MUST NOT match /var/app/uploads)
    expect(() => resolveConfinedPath('/var/app/uploads', '../uploads2/secret.txt')).toThrow(
      PathTraversalError,
    );

    // Filename sanitization
    expect(sanitizeFilename('../../etc/passwd')).toBe('passwd');
    expect(sanitizeFilename('..\\..\\secret.txt\u0000.jpg')).toBe('secret.txt_.jpg');
    expect(sanitizeFilename('.htaccess')).toBe('htaccess');
    expect(sanitizeFilename('CON')).toBe('file_CON');
    expect(sanitizeFilename('   ...   ')).toBe('file');
  });

  it('blocks private/metadata/obfuscated IPs, DNS rebinding, and redirect-to-metadata SSRF chains', async () => {
    // IP classification checks
    const blockedIps = [
      '127.0.0.1',
      '127.255.255.254',
      '10.0.0.1',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.1.10',
      '169.254.169.254',
      '100.64.0.1',
      '0.0.0.0',
      '224.0.0.1',
      '::1',
      '::',
      'fe80::1',
      'fc00::1',
      'fd12:3456::1',
      '::ffff:127.0.0.1',
      '::ffff:169.254.169.254',
      '::ffff:7f00:1',
      '::ffff:a9fe:a9fe',
    ];
    for (const ip of blockedIps) {
      expect(isPrivateOrReservedIp(ip)).toBe(true);
    }
    expect(isPrivateOrReservedIp('93.184.216.34')).toBe(false);
    expect(isPrivateOrReservedIp('2606:2800:220:1:248:1893:25c8:1946')).toBe(false);

    // URL validation checks including obfuscated loopback/metadata forms
    const blockedUrls = [
      'http://169.254.169.254/latest/meta-data/',
      'https://127.0.0.1/admin',
      'https://localhost:3000/internal',
      'https://metadata.google.internal/computeMetadata/v1/',
      'https://2130706433/secret', // decimal 127.0.0.1
      'https://0177.0.0.1/secret', // octal 127.0.0.1
      'https://0x7f000001/secret', // hex 127.0.0.1
      'https://[::1]/secret',
      'https://[::ffff:169.254.169.254]/latest/meta-data/',
      'file:///etc/passwd',
      'https://user:pass@example.com/resource',
    ];

    for (const badUrl of blockedUrls) {
      await expect(validateOutboundUrl(badUrl, { allowHttp: true })).rejects.toThrow(
        SsrfBlockedError,
      );
    }

    // DNS rebinding defense: public hostname resolves to cloud metadata IP -> BLOCKED!
    await expect(
      validateOutboundUrl('https://rebind.attacker.example/hook', {
        resolveHost: async () => ['169.254.169.254'],
      }),
    ).rejects.toThrow(SsrfBlockedError);

    // Redirect-to-metadata defense: public URL 302 redirects to 169.254.169.254 -> BLOCKED!
    const fakeFetch = async (input: string | URL | Request): Promise<Response> => {
      const target = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (target === 'https://public.example.com/start') {
        return new Response(null, {
          status: 302,
          headers: { location: 'http://169.254.169.254/latest/meta-data/' },
        });
      }
      if (target === 'https://public.example.com/ok-redirect') {
        return new Response(null, {
          status: 302,
          headers: { location: 'https://public.example.com/final' },
        });
      }
      if (target === 'https://public.example.com/final') {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      return new Response('unexpected', { status: 500 });
    };

    const safeFetch = createSafeFetch({
      fetchImpl: fakeFetch as typeof fetch,
      allowedHosts: ['public.example.com'],
      resolveHost: async () => ['93.184.216.34'],
    });

    await expect(safeFetch('https://public.example.com/start')).rejects.toThrow(SsrfBlockedError);

    const okRes = await safeFetch('https://public.example.com/ok-redirect');
    expect(okRes.status).toBe(200);
    expect(await okRes.json()).toEqual({ ok: true });
  });

  it('registers and exports security primitives via ForgeJS plugin DI tokens', async () => {
    const harness = createPluginTestHarness({
      plugin: createSecurityPlugin(),
      config: {
        rateLimit: { max: 5, windowMs: 60_000 },
        ssrf: { allowedHosts: ['api.example.com'] },
      },
    });

    await harness.start();
    const store = await harness.resolveExport(SecurityTokens.rateLimitStore);
    const safeFetch = await harness.resolveExport(SecurityTokens.safeFetch);

    const hit = await store.consume('k1', 60_000, 5);
    expect(hit.allowed).toBe(true);
    expect(hit.remaining).toBe(4);
    await expect(safeFetch('https://127.0.0.1/secret')).rejects.toThrow(SsrfBlockedError);

    await harness.shutdown();
  });
});
