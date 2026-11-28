export {
  base64UrlDecode,
  base64UrlEncode,
  constantTimeEqual,
  generateRandomBytes,
  generateSecureToken,
  sha256Base64Url,
  sha256Bytes,
  sha256Hex,
} from './crypto.js';

export {
  createAuthIdentity,
  type AuthIdentity,
  type AuthIdentityInput,
  type AuthMethod,
  type AuthStrategy,
} from './types.js';

export {
  createArgon2PasswordHasher,
  createWebCryptoPasswordHasher,
  type Argon2PasswordHasherOptions,
  type PasswordHasher,
  type WebCryptoPasswordHasherOptions,
} from './password.js';

export {
  createJwtAuthStrategy,
  createJwtService,
  extractBearerToken,
  type JwtAlgorithm,
  type JwtAuthStrategyOptions,
  type JwtService,
  type JwtServiceOptions,
  type JwtSignOptions,
  type JwtVerifyResult,
} from './jwt.js';

export {
  createMemorySessionStore,
  createSessionAuthStrategy,
  createSessionManager,
  parseCookies,
  serializeCookie,
  type CookieSameSite,
  type SessionCookieOptions,
  type SessionCreateInput,
  type SessionCreateResult,
  type SessionManager,
  type SessionManagerOptions,
  type SessionRecord,
  type SessionStore,
} from './session.js';

export {
  createApiKeyAuthStrategy,
  createApiKeyManager,
  createMemoryApiKeyStore,
  type ApiKeyAuthStrategyOptions,
  type ApiKeyManager,
  type ApiKeyManagerOptions,
  type ApiKeyRecord,
  type ApiKeyStore,
  type CreateApiKeyInput,
  type IssuedApiKey,
} from './api-key.js';

export {
  buildAuthorizationUrl,
  createOAuthState,
  createPkceChallenge,
  verifyOAuthCallbackState,
  verifyOidcIdToken,
  type BuildAuthorizationUrlOptions,
  type OAuthStateBundle,
  type OidcAsymmetricAlgorithm,
  type PkceChallenge,
  type VerifiedOidcIdToken,
  type VerifyOidcIdTokenOptions,
} from './oauth.js';

export {
  createBetterAuthStrategy,
  mountBetterAuth,
  type BetterAuthInstanceLike,
  type BetterAuthSessionLike,
  type BetterAuthSessionResult,
  type BetterAuthStrategyOptions,
  type BetterAuthUserLike,
} from './better-auth.js';

export {
  AuthIdentityKey,
  createAuthMiddleware,
  getAuth,
  requireAuth,
  setAuthIdentity,
  type AuthMiddlewareOptions,
} from './middleware.js';

export {
  AuthTokens,
  createAuthPlugin,
  type AuthPluginConfig,
  type AuthPluginOptions,
} from './plugin.js';
