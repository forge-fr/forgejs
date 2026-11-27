# Authentication

> Cross-runtime OWASP Argon2id hashing, algorithm-pinned JWT/JWKS, SHA-256 hashed sessions and API keys, OAuth 2.0 PKCE/OIDC, and Better Auth.

- **Section**: Authentication & Security
- **Packages**: @forge-fr/auth
- **Version**: v1.0.0-rc.2
- **Updated**: 2026-11-26
- **HTML URL**: https://github.com/forge-fr/forgejs/docs/security/authentication
- **Markdown URL**: https://github.com/forge-fr/forgejs/docs/security/authentication.md
- **Source**: https://github.com/forge-fr/forgejs/blob/main/docs/data-and-auth.md

## Password hashing, algorithm-pinned JWTs & hashed sessions

- createArgon2PasswordHasher() enforces OWASP Argon2id floors (memoryCost >= 12288 KiB, default 19456, timeCost >= 2, 1024-byte cap) and is verified cross-compatible between @node-rs/argon2 and Bun.password.
- createJwtService() requires an explicit algorithms allowlist, rejects alg: none, and enforces >=32-byte HMAC secrets.
- Session IDs and API keys are stored strictly as SHA-256 hex digests and verified in constant time.

**File: `src/auth.ts`**

```ts
import { secret } from '@forge-fr/core';
import {
  createArgon2PasswordHasher,
  createJwtService,
  createMemorySessionStore,
  createSessionManager,
} from '@forge-fr/auth';

const hasher = createArgon2PasswordHasher();
const hash = await hasher.hash('CorrectHorseBattery99!');
const valid = await hasher.verify('CorrectHorseBattery99!', hash);

const jwt = createJwtService({
  algorithms: ['HS256'],
  secret: secret('super-secret-signing-key-at-least-32-bytes'),
  issuer: 'https://auth.example.com',
  audience: 'forge-api',
});
const token = await jwt.sign({ sub: 'user-1', role: 'editor' }, { expiresIn: '10m' });

const sessions = createSessionManager({
  store: createMemorySessionStore(),
  idleTtlMs: 30 * 60_000,
  absoluteTtlMs: 24 * 60 * 60_000,
});
```

## OAuth 2.0 PKCE / OIDC & Better Auth bridge

@forge-fr/auth includes createOAuthPkceClient() (S256 PKCE + state/nonce validation), createApiKeyService(), and mountBetterAuth() / createBetterAuthBridge() for teams adopting Better Auth.
