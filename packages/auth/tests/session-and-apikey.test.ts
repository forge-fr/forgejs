import { describe, expect, it } from 'vitest';
import { ConfigurationError } from '@forge-fr/core';
import {
  createApiKeyManager,
  createMemoryApiKeyStore,
  createMemorySessionStore,
  createSessionManager,
  parseCookies,
  serializeCookie,
} from '../src/index.js';

describe('@forge-fr/auth Sessions, Cookies & API Keys (M4.3)', () => {
  it('stores only SHA-256 hashed session IDs, enforces idle & absolute TTL, and prevents session fixation via rotate()', async () => {
    let nowMs = 1_700_000_000_000;
    const store = createMemorySessionStore();
    const sessions = createSessionManager({
      store,
      now: () => nowMs,
      idleTtlSeconds: 60,
      absoluteTtlSeconds: 300,
      cookie: { name: 'forge_sid', secure: true, sameSite: 'Lax' },
    });

    const created = await sessions.create('user_1', {
      roles: ['member'],
      tenantId: 'org_1',
    });

    expect(created.sessionId.length).toBeGreaterThanOrEqual(40);
    expect(created.setCookieHeader).toContain('forge_sid=');
    expect(created.setCookieHeader).toContain('HttpOnly');
    expect(created.setCookieHeader).toContain('Secure');
    expect(created.setCookieHeader).toContain('SameSite=Lax');

    // SECURITY: Raw session ID must NEVER be stored as the store key
    expect(await store.get(created.sessionId)).toBeNull();
    expect(await sessions.verify(created.sessionId)).not.toBeNull();

    // Rotate session ID on login / privilege escalation (prevents session fixation)
    const rotated = await sessions.rotate(created.sessionId, { roles: ['admin'] });
    expect(rotated).not.toBeNull();
    expect(rotated!.sessionId).not.toBe(created.sessionId);
    expect(await sessions.verify(created.sessionId)).toBeNull();

    const verifiedRotated = await sessions.verify(rotated!.sessionId);
    expect(verifiedRotated?.subject).toBe('user_1');
    expect(verifiedRotated?.roles).toEqual(['admin']);

    // Idle expiration check
    nowMs += 61_000;
    expect(await sessions.verify(rotated!.sessionId)).toBeNull();

    // Absolute expiration check even with sliding activity
    const sliding = await sessions.create('user_2');
    for (let i = 0; i < 6; i += 1) {
      nowMs += 45_000;
      await sessions.verify(sliding.sessionId);
    }
    nowMs += 45_000;
    expect(await sessions.verify(sliding.sessionId)).toBeNull();

    // Revoke all sessions for a subject
    const s1 = await sessions.create('user_3');
    const s2 = await sessions.create('user_3');
    await sessions.revokeAllForSubject('user_3');
    expect(await sessions.verify(s1.sessionId)).toBeNull();
    expect(await sessions.verify(s2.sessionId)).toBeNull();
  });

  it('hardens cookie serialization and prototype-pollution-safe cookie parsing', () => {
    const parsed = parseCookies('forge_sid=abc123; __proto__=polluted; constructor=bad; theme=dark');
    expect(Object.getPrototypeOf(parsed)).toBeNull();
    expect(parsed['forge_sid']).toBe('abc123');
    expect(parsed['theme']).toBe('dark');
    expect(parsed['__proto__']).toBeUndefined();
    expect(parsed['constructor']).toBeUndefined();

    // Reject CRLF header injection
    expect(() => serializeCookie('bad\r\nname', 'val')).toThrow(ConfigurationError);
    expect(() => serializeCookie('sid', 'val\nSet-Cookie: evil=1')).toThrow(ConfigurationError);

    // Reject SameSite=None without Secure
    expect(() => serializeCookie('sid', 'val', { sameSite: 'None', secure: false })).toThrow(
      ConfigurationError,
    );

    const partitioned = serializeCookie('sid', 'val', {
      sameSite: 'None',
      secure: true,
      partitioned: true,
    });
    expect(partitioned).toContain('SameSite=None');
    expect(partitioned).toContain('Secure');
    expect(partitioned).toContain('Partitioned');
  });

  it('creates prefixed high-entropy API keys stored only as SHA-256 hashes and enforces expiration & revocation', async () => {
    let nowMs = 1_700_000_000_000;
    const store = createMemoryApiKeyStore();
    const apiKeys = createApiKeyManager({
      store,
      prefix: 'fjs_live',
      now: () => nowMs,
    });

    const issued = await apiKeys.create({
      subject: 'svc_billing',
      name: 'CI Deploy Key',
      scopes: ['invoices:read', 'invoices:write'],
      tenantId: 'tenant_9',
      expiresInSeconds: 120,
    });

    expect(issued.apiKey.startsWith('fjs_live_')).toBe(true);
    // Stored record contains hash, never raw key
    expect(JSON.stringify(issued.record)).not.toContain(issued.apiKey);

    const verified = await apiKeys.verify(issued.apiKey);
    expect(verified?.subject).toBe('svc_billing');
    expect(verified?.scopes).toEqual(['invoices:read', 'invoices:write']);
    expect(verified?.tenantId).toBe('tenant_9');

    // Reject tampered secret
    expect(await apiKeys.verify(`${issued.apiKey}x`)).toBeNull();
    expect(await apiKeys.verify('invalid-key-format')).toBeNull();

    // Revocation
    await apiKeys.revoke(issued.record.id);
    expect(await apiKeys.verify(issued.apiKey)).toBeNull();

    // Expiration
    const shortLived = await apiKeys.create({
      subject: 'svc_temp',
      name: 'Temp Key',
      expiresInSeconds: 30,
    });
    expect(await apiKeys.verify(shortLived.apiKey)).not.toBeNull();
    nowMs += 31_000;
    expect(await apiKeys.verify(shortLived.apiKey)).toBeNull();
  });
});
