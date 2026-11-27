# @forge-fr/auth

Modular authentication suite for ForgeJS running natively on both Node.js and Bun.

## Capabilities

- **Password Hashing:** OWASP-compliant Argon2id (`@node-rs/argon2` on Node.js and native `Bun.password` on Bun with full cross-runtime PHC hash interoperability).
- **JWT & JWKS:** Powered by `jose` with mandatory explicit algorithm allowlists, minimum 256-bit HMAC secret enforcement, `iss`/`aud`/`exp`/`nbf` validation, and `alg: none` rejection.
- **Sessions & Cookies:** 256-bit CSPRNG opaque session IDs stored exclusively as SHA-256 digests, idle & absolute TTL expiration, atomic rotation against session fixation, and hardened `HttpOnly; Secure; SameSite` cookie helpers.
- **API Keys:** Prefixed 256-bit API keys stored only as SHA-256 digests with constant-time verification, scopes, expiration, and revocation.
- **OAuth 2.0 & OIDC:** PKCE S256 challenge generation, allowlisted redirect URI validation, constant-time `state` verification, and OIDC `id_token` verification with `nonce` matching.
- **Better Auth Adapter:** Native Web Standards handler mounting and ForgeJS HTTP middleware strategy preserving Better Auth's full native API.
