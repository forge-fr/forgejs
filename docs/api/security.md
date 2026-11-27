# @forge-fr/security

> OWASP ASVS 5.0.0 security headers & CSP, strict CORS, CSRF protection, hardened cookies, proxy-safe rate limiting, SSRF-blocking safe fetch, and symlink-jailed path resolution.

- **Version**: v1.0.0-rc.1
- **Layer**: Adapter Layer
- **Category**: security
- **Tarball**: 25.8 kB (44 files)
- **Internal deps**: @forge-fr/core, @forge-fr/http
- **Runtime deps**: zero runtime dependencies
- **Peer deps**: none
- **HTML URL**: https://github.com/forge-fr/forgejs/api/security
- **Markdown URL**: https://github.com/forge-fr/forgejs/api/security.md

## Installation

```bash
npm install @forge-fr/security
```

## Plugin Metadata

- **Factory**: `createSecurityPlugin`
- **Tokens**: `SecurityTokens`
- **Health probe**: `security`
- **Capabilities**: `di:register`, `health:register`

## Runtime & Error Semantics

- **Runtime**: Zero third-party runtime dependencies. Aligns with OWASP ASVS 5.0.0 controls across headers, CORS, CSRF, rate limits, and SSRF.
- **Errors**: Throws ConfigurationError at boot if CORS combines wildcard * with credentials: true; blocks private/loopback/link-local SSRF targets with SsrfBlockedError.

## Usage Example

```ts
import { createHttpApp } from '@forge-fr/http';
import { createSecurityHeadersMiddleware, createCorsMiddleware, createSafeFetch } from '@forge-fr/security';

const app = createHttpApp();
app.use(createSecurityHeadersMiddleware());
app.use(createCorsMiddleware({ origin: 'https://app.example.com', credentials: true }));

const safeFetch = createSafeFetch();
```

## Public Exports

### HTTP Security Middleware, SSRF & Path Confinement

- **Values**: `buildCspHeader`, `createSecurityHeadersMiddleware`, `createCorsMiddleware`, `generateCsrfToken`, `createCsrfMiddleware`, `serializeHardenedCookie`, `createMemoryRateLimitStore`, `createRateLimitMiddleware`, `extractClientIp`, `isDangerousPropertyKey`, `sanitizeObject`, `safeJsonParse`, `sanitizeFilename`, `resolveConfinedPath`, `isPrivateOrReservedIp`, `validateOutboundUrl`, `createSafeFetch`, `SecurityTokens`, `createSecurityPlugin`, `PathTraversalError`, `RateLimitExceededError`, `SsrfBlockedError`
- **Types**: `ClientIpOptions`, `CorsOptions`, `CorsOriginRule`, `CspDirectives`, `CsrfMiddlewareOptions`, `HardenedCookieOptions`, `HstsOptions`, `MemoryRateLimitStoreOptions`, `RateLimitConsumeResult`, `RateLimitMiddlewareOptions`, `RateLimitStore`, `SafeFetch`, `SafeFetchOptions`, `SafeOutboundUrlOptions`, `SanitizeFilenameOptions`, `SanitizeObjectOptions`, `SecurityHeadersOptions`, `SecurityPluginConfig`, `SecurityPluginOptions`
