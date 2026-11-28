# Changelog — @forge-fr/auth

## 0.1.0 (2026-11-25)

- Initial release of `@forge-fr/auth` (Phase 4 — Milestone 4.3).
- Added OWASP-hardened Argon2id password hasher (`createArgon2PasswordHasher`), `jose`-based JWT service (`createJwtService`), hashed session manager with fixation-safe rotation (`createSessionManager`), hashed API key manager (`createApiKeyManager`), OAuth 2.0/OIDC PKCE & ID token primitives, Better Auth adapter (`mountBetterAuth`, `createBetterAuthStrategy`), multi-strategy HTTP middleware (`createAuthMiddleware`, `getAuth`, `requireAuth`), and ForgeJS DI plugin (`createAuthPlugin`).

## [1.0.0] - 2026-11-27

### Added & Changed
- Added `AuthIdentityKey` typed context key, lazy dynamic `@node-rs/argon2` import for Edge bundle compatibility, and native Web Crypto PBKDF2-HMAC-SHA256 `createWebCryptoPasswordHasher()`.

