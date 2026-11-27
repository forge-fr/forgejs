import { describe, expect, it } from 'vitest';
import { generateKeyPair } from 'jose';
import { ConfigurationError, UnauthorizedError, secret } from '@forge-fr/core';
import {
  base64UrlEncode,
  constantTimeEqual,
  createArgon2PasswordHasher,
  createJwtService,
} from '../src/index.js';

describe('@forge-fr/auth Password Hashing (Argon2id) & JWT (jose) (M4.3)', () => {
  it('hashes and verifies passwords with OWASP Argon2id parameters, detects rehash need, and blocks weak configs / oversized passwords', async () => {
    const hasher = createArgon2PasswordHasher();
    const hashed = await hasher.hash('Correct-Horse-Battery-Staple-2026!');

    expect(hashed.startsWith('$argon2id$v=19$m=19456,t=2,p=1$')).toBe(true);
    expect(await hasher.verify('Correct-Horse-Battery-Staple-2026!', hashed)).toBe(true);
    expect(await hasher.verify('Wrong-Password!', hashed)).toBe(false);
    expect(hasher.needsRehash(hashed)).toBe(false);

    const strongerHasher = createArgon2PasswordHasher({ memoryCost: 32768, timeCost: 3 });
    expect(strongerHasher.needsRehash(hashed)).toBe(true);

    // Reject weak OWASP floors at startup
    expect(() => createArgon2PasswordHasher({ memoryCost: 4096 })).toThrow(ConfigurationError);
    expect(() => createArgon2PasswordHasher({ timeCost: 1 })).toThrow(ConfigurationError);

    // Reject empty or DoS-sized passwords
    await expect(hasher.hash('')).rejects.toThrow();
    await expect(hasher.hash('a'.repeat(2048))).rejects.toThrow();
    expect(await hasher.verify('a'.repeat(2048), hashed)).toBe(false);
  });

  it('signs and verifies HS256 JWTs via jose and enforces strict SecretValue length and algorithm allowlists', async () => {
    // Reject weak secret (< 32 bytes) and empty/none algorithm allowlists
    expect(() =>
      createJwtService({
        algorithms: ['HS256'],
        secret: 'too-short-secret',
      }),
    ).toThrow(ConfigurationError);

    expect(() =>
      createJwtService({
        algorithms: [],
        secret: 'a-very-strong-256-bit-secret-key-for-forgejs-jwt',
      }),
    ).toThrow(ConfigurationError);

    expect(() =>
      createJwtService({
        algorithms: ['none' as never],
        secret: 'a-very-strong-256-bit-secret-key-for-forgejs-jwt',
      }),
    ).toThrow(ConfigurationError);

    const jwt = createJwtService({
      algorithms: ['HS256'],
      secret: secret('super-strong-hmac-signing-key-with-over-32-bytes-entropy'),
      issuer: 'https://auth.forgejs.dev',
      audience: 'forge-api',
      defaultExpiresIn: '5m',
    });

    const token = await jwt.sign({
      sub: 'user_42',
      roles: ['admin'],
      tenantId: 'tenant_acme',
    });

    const verified = await jwt.verify<{ roles: string[]; tenantId: string }>(token);
    expect(verified.payload.sub).toBe('user_42');
    expect(verified.payload.roles).toEqual(['admin']);
    expect(verified.payload.tenantId).toBe('tenant_acme');
    expect(verified.protectedHeader.alg).toBe('HS256');

    // SECURITY REGRESSION: Reject forged alg: none JWT
    const headerNone = base64UrlEncode(new TextEncoder().encode(JSON.stringify({ alg: 'none', typ: 'JWT' })));
    const payloadFake = base64UrlEncode(
      new TextEncoder().encode(
        JSON.stringify({
          sub: 'admin_spoof',
          iss: 'https://auth.forgejs.dev',
          aud: 'forge-api',
          exp: Math.floor(Date.now() / 1000) + 300,
        }),
      ),
    );
    const algNoneToken = `${headerNone}.${payloadFake}.`;
    await expect(jwt.verify(algNoneToken)).rejects.toThrow(UnauthorizedError);

    // SECURITY REGRESSION: Reject tampered signature
    const parts = token.split('.');
    const tampered = `${parts[0]}.${parts[1]}.tampered_sig`;
    await expect(jwt.verify(tampered)).rejects.toThrow(UnauthorizedError);

    // SECURITY REGRESSION: Reject algorithm mismatch (HS384 token into HS256-only verifier)
    const hs384Jwt = createJwtService({
      algorithms: ['HS384'],
      secret: secret('super-strong-hmac-signing-key-with-over-32-bytes-entropy'),
      issuer: 'https://auth.forgejs.dev',
      audience: 'forge-api',
    });
    const hs384Token = await hs384Jwt.sign({ sub: 'user_42' });
    await expect(jwt.verify(hs384Token)).rejects.toThrow(UnauthorizedError);

    // SECURITY REGRESSION: Reject wrong audience / issuer
    const wrongAudJwt = createJwtService({
      algorithms: ['HS256'],
      secret: secret('super-strong-hmac-signing-key-with-over-32-bytes-entropy'),
      issuer: 'https://auth.forgejs.dev',
      audience: 'other-service',
    });
    const wrongAudToken = await wrongAudJwt.sign({ sub: 'user_42' });
    await expect(jwt.verify(wrongAudToken)).rejects.toThrow(UnauthorizedError);
  });

  it('supports asymmetric ES256 JWT signing/verification and constant-time comparison', async () => {
    const { privateKey, publicKey } = await generateKeyPair('ES256');
    const signer = createJwtService({
      algorithms: ['ES256'],
      signingKey: privateKey,
      verificationKey: publicKey,
      issuer: 'forge-idp',
      audience: 'forge-web',
    });

    const token = await signer.sign({ sub: 'usr_asymmetric' }, { expiresIn: '2m' });
    const verified = await signer.verify(token);
    expect(verified.payload.sub).toBe('usr_asymmetric');
    expect(verified.protectedHeader.alg).toBe('ES256');

    expect(constantTimeEqual('abc123', 'abc123')).toBe(true);
    expect(constantTimeEqual('abc123', 'abc124')).toBe(false);
    expect(constantTimeEqual('abc123', 'abc1234')).toBe(false);
  });
});
