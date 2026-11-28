# @forge-fr/auth

> Argon2id (Node/Bun) and Web Crypto PBKDF2-SHA256 (Edge) password hashing, typed AuthIdentityKey, strict JWT/JWKS verification, hashed sessions/API keys, OAuth 2.0 PKCE, and Better Auth.

- **Version**: v1.0.0
- **Layer**: Adapter Layer
- **Category**: security
- **Tarball**: 27.6 kB (48 files)
- **Internal deps**: @forge-fr/core, @forge-fr/http
- **Runtime deps**: jose ^6.2.18
- **Peer deps**: @node-rs/argon2 >=2.0.0 (optional), better-auth >=1.0.0 (optional)
- **HTML URL**: https://github.com/forge-fr/forgejs/api/auth
- **Markdown URL**: https://github.com/forge-fr/forgejs/api/auth.md

## Installation

```bash
# Add once to .npmrc: @forge-fr:registry=https://npm.pkg.github.com
npm install @forge-fr/auth
```

## Plugin Metadata

- **Factory**: `createAuthPlugin`
- **Tokens**: `AuthTokens`
- **Health probe**: `auth`
- **Capabilities**: `di:register`, `health:register`

## Runtime & Error Semantics

- **Runtime**: Uses jose for JWT/JWKS. Argon2id password hashing is verified cross-compatible between @node-rs/argon2 (Node.js) and native Bun.password (Bun).
- **Errors**: Blocks alg: none, requires explicit JWT algorithms allowlist and >=32-byte HMAC secrets, hashes session IDs and API keys with SHA-256 before persistence.

## Usage Example

```ts
import { createArgon2PasswordHasher, createJwtService } from '@forge-fr/auth';

const hasher = createArgon2PasswordHasher();
const hash = await hasher.hash('correct-horse-battery-staple');
const valid = await hasher.verify('correct-horse-battery-staple', hash);
```

## Public Exports

### Passwords, Crypto & Identity

- **Values**: `createAuthIdentity`, `createArgon2PasswordHasher`, `createWebCryptoPasswordHasher`, `base64UrlDecode`, `base64UrlEncode`, `constantTimeEqual`, `generateRandomBytes`, `generateSecureToken`, `sha256Base64Url`, `sha256Bytes`, `sha256Hex`
- **Types**: `AuthIdentity`, `AuthIdentityInput`, `AuthMethod`, `AuthStrategy`, `Argon2PasswordHasherOptions`, `PasswordHasher`, `WebCryptoPasswordHasherOptions`

### JWT, Sessions, API Keys, OAuth/OIDC & Better Auth

- **Values**: `createJwtService`, `createJwtAuthStrategy`, `extractBearerToken`, `createSessionManager`, `createMemorySessionStore`, `createSessionAuthStrategy`, `parseCookies`, `serializeCookie`, `createApiKeyManager`, `createMemoryApiKeyStore`, `createApiKeyAuthStrategy`, `createPkceChallenge`, `createOAuthState`, `buildAuthorizationUrl`, `verifyOAuthCallbackState`, `verifyOidcIdToken`, `mountBetterAuth`, `createBetterAuthStrategy`
- **Types**: `JwtAlgorithm`, `JwtAuthStrategyOptions`, `JwtService`, `JwtServiceOptions`, `JwtSignOptions`, `JwtVerifyResult`, `CookieSameSite`, `SessionCookieOptions`, `SessionCreateInput`, `SessionCreateResult`, `SessionManager`, `SessionManagerOptions`, `SessionRecord`, `SessionStore`, `ApiKeyAuthStrategyOptions`, `ApiKeyManager`, `ApiKeyManagerOptions`, `ApiKeyRecord`, `ApiKeyStore`, `CreateApiKeyInput`, `IssuedApiKey`, `BuildAuthorizationUrlOptions`, `OAuthStateBundle`, `OidcAsymmetricAlgorithm`, `PkceChallenge`, `VerifiedOidcIdToken`, `VerifyOidcIdTokenOptions`, `BetterAuthInstanceLike`, `BetterAuthSessionLike`, `BetterAuthSessionResult`, `BetterAuthStrategyOptions`, `BetterAuthUserLike`

### HTTP Auth Middleware & Plugin

- **Values**: `AuthIdentityKey`, `createAuthMiddleware`, `getAuth`, `requireAuth`, `setAuthIdentity`, `AuthTokens`, `createAuthPlugin`
- **Types**: `AuthMiddlewareOptions`, `AuthPluginConfig`, `AuthPluginOptions`
