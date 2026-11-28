# Authentication

> Strong Argon2id password hashing, strict JWT verification, hashed sessions and API keys, OAuth 2.0 PKCE, and Better Auth.

- **Section**: Authentication & Security
- **Packages**: @forge-fr/auth
- **Version**: v1.0.0
- **Updated**: 2026-11-27
- **HTML URL**: https://github.com/forge-fr/forgejs/docs/security/authentication
- **Markdown URL**: https://github.com/forge-fr/forgejs/docs/security/authentication.md
- **Source**: https://github.com/forge-fr/forgejs/blob/main/docs/data-and-auth.md

## Passwords, JWTs, and hashed sessions

- createArgon2PasswordHasher() enforces OWASP Argon2id strength settings and works seamlessly across Node.js (@node-rs/argon2) and Bun (Bun.password).
- createJwtService() requires an explicit list of allowed algorithms, blocks alg: none, and requires at least 32-byte HMAC secrets.
- Session tokens and API keys are stored only as SHA-256 hashes and compared in constant time to prevent timing attacks.

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

## OAuth 2.0 PKCE / OIDC & Better Auth support

@forge-fr/auth also provides createOAuthPkceClient() (with S256 PKCE and state/nonce checks), createApiKeyService(), and mountBetterAuth() / createBetterAuthBridge() if you use Better Auth.
