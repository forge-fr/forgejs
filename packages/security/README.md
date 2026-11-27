# @forge-fr/security

Runtime-neutral OWASP ASVS 5.0.0 security suite for ForgeJS running identically on Node.js and Bun with zero third-party runtime dependencies.

## Key Capabilities

- **Hardened Security Headers (`createSecurityHeadersMiddleware`, `buildCspHeader`):** Applies `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Resource-Policy: same-origin`, `Permissions-Policy`, HSTS, and CSP across all responses including errors.
- **Strict CORS (`createCorsMiddleware`):** Disabled by default, explicit allowlist matching, `Vary: Origin`, and a fatal startup `ConfigurationError` when wildcard `*` is combined with `credentials: true`.
- **CSRF Protection (`createCsrfMiddleware`, `generateCsrfToken`):** Synchronizer/double-submit token verification with constant-time comparison plus `Origin` / `Sec-Fetch-Site` validation on state-changing requests.
- **Pluggable Rate Limiting (`createRateLimitMiddleware`, `createMemoryRateLimitStore`, `extractClientIp`):** Bounded sliding-window store, trusted-proxy-aware client IP extraction ignoring spoofed `X-Forwarded-For` by default, and `429` + `Retry-After` responses.
- **Prototype Pollution, Path Confinement & Safe Filenames (`sanitizeObject`, `safeJsonParse`, `resolveConfinedPath`, `sanitizeFilename`):** Recursive key stripping, depth caps, multi-pass percent-decoded traversal rejection, and safe filename normalization.
- **SSRF-Safe Fetch Guard (`validateOutboundUrl`, `isPrivateOrReservedIp`, `createSafeFetch`):** Blocks non-HTTP(S), embedded credentials, IPv4/IPv6/mapped/decimal/octal/hex private & metadata IPs, DNS rebinding via pluggable resolver, and unsafe redirect hops.
- **Hardened Cookie Serializer (`serializeHardenedCookie`):** Enforces `HttpOnly`, `Secure`, `SameSite`, `__Host-`/`__Secure-` prefix invariants, and header-injection protection.
- **ForgeJS DI Plugin (`createSecurityPlugin`, `SecurityTokens`):** Registers and exports configured security primitives.
