# ForgeJS — Security Architecture & Threat Model

**Status:** Phase 7 — M7.3 OWASP ASVS 5.0.0 Security Audit Signed Off (2026-11-26 · `v1.0.0-rc.1`)  
**Verification Baseline:** OWASP ASVS 5.0.0 (Backend Framework Controls) + OWASP Top 10 + OWASP API Security Top 10

---

## Supported Versions

| Version | Supported |
| :--- | :--- |
| `1.0.x` (`main`) | :white_check_mark: Yes |
| `< 1.0.0` | :x: No |

## Reporting a Vulnerability

We take security reports seriously across all 21 packages. **Please do not report security vulnerabilities through public GitHub Issues, Discussions, or Pull Requests.**

Instead, please report them privately using **GitHub Private Vulnerability Reporting**:

1. Open [https://github.com/forge-fr/forgejs/security/advisories/new](https://github.com/forge-fr/forgejs/security/advisories/new).
2. Include the affected package(s), reproduction steps or proof of concept, runtime target (Node.js, Bun, or WinterCG Edge), and potential impact.
3. Maintainers aim to acknowledge valid reports within **48 hours**, confirm severity/remediation plan within **5 business days**, and coordinate a patched release before public advisory disclosure.

---

## 1. System Threat Model & Trust Boundaries

### Trust Boundaries
1. **Boundary A — Network / Client → HTTP Adapter:** All incoming HTTP method, URL, path params, query strings, headers, cookies, and request bodies are **strictly untrusted**.
2. **Boundary B — HTTP Layer → Application Services:** Validation proves structural shape only; **authorization** must still verify actor identity, role/permission, tenant isolation, and resource ownership at service boundaries.
3. **Boundary C — Application → Infrastructure (DB / Storage / Outbound HTTP):** Parameterized queries only, canonicalized root-jailed file paths, and SSRF-checked outbound URLs.
4. **Boundary D — Framework Core ↔ Third-Party Plugins:** Plugins are **trusted executable code** running in the same JavaScript runtime. ForgeJS provides capability-scoped APIs (`PluginContext`) to prevent accidental internal coupling and enforce architectural discipline, **not** cryptographic or VM sandboxing against malicious npm packages.

### STRIDE Threat Analysis Summary

| Threat Category | Concrete Attack Vector | ForgeJS Architectural Control |
| :--- | :--- | :--- |
| **Spoofing** | Forged JWTs (`alg: none`), weak session cookies, credential stuffing | `jose` strict algorithm allowlist; `HttpOnly`, `Secure`, `SameSite=Lax` cookies; rate limiting; Argon2id hashing |
| **Tampering** | Prototype pollution (`__proto__`), CSRF state changes, mass assignment | Null-prototype/sanitized body & query parsing; CSRF token validation; explicit schema allowlists (strip unknown keys by default) |
| **Repudiation** | Missing audit trail, spoofed `X-Forwarded-For` / `X-Request-Id` | Trusted-proxy opt-in configuration; server-generated correlation IDs; structured audit logs |
| **Information Disclosure** | Stack traces in 500s, secrets in logs, CORS `*` with credentials | `ForgeError.expose` defaults to `false` for 5xx; redaction paths in logger; startup hard-error on wildcard CORS + credentials |
| **Denial of Service** | Oversized JSON/multipart payloads, slowloris, router ReDoS, unbounded DI | Explicit `maxBodyBytes` (default 1 MiB), request timeouts, non-backtracking radix router, bounded multipart limits, rate limiting |
| **Elevation of Privilege** | IDOR on `/users/:id`, tenant data bleed, bypassed route middleware | Service-level `Authorizer.assert(actor, action, resource)` enforcing RBAC + resource ownership + tenant match |

---

## 2. OWASP ASVS 5.0.0 Control Mapping

| Control Domain | ForgeJS Default Behavior & Requirement | Package | Verification Test |
| :--- | :--- | :--- | :--- |
| **Input Validation & Encoding** | Schema validation via Standard Schema (`zod`/`valibot`) strips unknown properties by default; validation separated from authorization. | `@forge-fr/validation` | Reject unknown keys, invalid types, oversized arrays/strings |
| **Prototype Pollution Defense** | Recursive key sanitizer / safe JSON reviver rejecting `__proto__`, `constructor`, and `prototype` keys in parsed payloads and queries. | `@forge-fr/http`, `@forge-fr/security` | `fast-check` + explicit pollution regression vectors |
| **Secure HTTP Headers** | Defaults: `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `Cross-Origin-Opener-Policy: same-origin`, `Permissions-Policy`, configurable CSP & HSTS (when HTTPS). | `@forge-fr/security` | Header assertion suite on all responses including errors |
| **CORS Policy** | Disabled by default (same-origin). Explicit origin allowlist required. **Throws fatal config error at startup** if `origin: "*"` is combined with `credentials: true`. | `@forge-fr/security` | Boot-time rejection test + preflight/reflect-origin regression tests |
| **CSRF Protection** | Synchronizer token / double-submit cookie + `Origin`/`Sec-Fetch-Site` verification for cookie-authenticated state-changing requests (`POST`, `PUT`, `PATCH`, `DELETE`). | `@forge-fr/security` | Cross-origin state mutation rejection tests |
| **Rate Limiting** | Pluggable sliding-window / token-bucket limiter with key extraction honoring trusted proxy configuration; returns `429` + `Retry-After`. | `@forge-fr/security` | Burst throttling & trusted-proxy spoof tests |
| **Request & Upload Limits** | Default JSON/text body cap `1 MiB`; explicit multipart file count, file size, MIME allowlist, and filename sanitization (never use raw client filename as path). | `@forge-fr/http`, `@forge-fr/security` | Oversized stream abort (`413`) & malicious filename tests |
| **Path Traversal Protection** | Canonical path resolution (`path.resolve` + root prefix verification + null-byte rejection) in local storage and static serving. | `@forge-fr/storage` | Encoded `../`, `%2e%2e`, symlink & null-byte fuzz tests |
| **SSRF Protection** | Optional safe HTTP fetch wrapper resolving DNS and blocking loopback (`127.0.0.0/8`, `::1`), RFC1918 private ranges, link-local (`169.254.0.0/16` cloud metadata), and non-HTTP(S) schemes. | `@forge-fr/security` | Private IP, IPv6-mapped IPv4, redirect-to-metadata tests |
| **SQL Injection Prevention** | ORM adapters enforce parameterized queries (`drizzle-orm`, `prisma`, `postgres` tagged templates); raw query helpers require bound parameters. | `@forge-fr/database`, `@forge-fr/drizzle`, `@forge-fr/prisma` | Parameter binding & injection payload tests in CI |
| **Password Security** | Argon2id (`@node-rs/argon2` on Node.js; `Bun.password` Argon2id on Bun) with OWASP recommended memory/iteration parameters. Zero custom crypto. | `@forge-fr/auth` | Hash format, constant-time verify, cross-runtime verify tests |
| **Session & Cookie Security** | Cryptographically random session IDs ($\ge 128$ bits entropy), rotation on login/privilege change, idle & absolute expiration, `HttpOnly`, `Secure` (production default), `SameSite=Lax`. | `@forge-fr/auth` | Session fixation & cookie flag regression tests |
| **JWT / OAuth2 / OIDC** | Built on `jose` with mandatory explicit `algorithms` allowlist, `iss`/`aud`/`exp`/`nbf` verification, and JWKS caching. | `@forge-fr/auth` | `alg: none`, key confusion, expired/wrong-aud token rejection |
| **Authorization & Anti-IDOR** | Policy & resource-level guards enforceable in application services; multi-tenant context requires explicit `tenantId` match. | `@forge-fr/authorization` | Cross-tenant and cross-user IDOR denial tests |
| **Error Sanitization** | Production mode (`NODE_ENV=production`) strips stack traces, internal causes, and SQL details from non-exposed errors, returning generic safe JSON + `requestId`. | `@forge-fr/core`, `@forge-fr/http` | Error response snapshot tests in dev vs production mode |
| **Log Redaction & Secret Mgmt** | Redacts `authorization`, `cookie`, `set-cookie`, `password`, `token`, `secret`, `apiKey` recursively; `ConfigManager` supports `secret()` fields masked in serialization. | `@forge-fr/core`, `@forge-fr/logger` | Log output capture asserting zero leaked credentials |

---

## 3. Supply-Chain & Dependency Security Policy

1. **Zero Custom Cryptography:** All hashing, JWT signing, encryption, and CSPRNG operations use Web Crypto API (`crypto.getRandomValues`, `crypto.subtle`), `@node-rs/argon2`, `Bun.password`, or `jose`.
2. **Minimal Core Dependency Tree:** `@forge-fr/core` and `@forge-fr/router` maintain **zero runtime dependencies** to minimize supply-chain attack surface.
3. **Automated Audits:** CI executes dependency vulnerability checks on every PR and fails on unresolved `high` or `critical` advisories unless an explicit, time-bounded risk exception is documented in `SECURITY.md`.
4. **Controlled Publishing:** Packages publish only via CI with npm OIDC provenance (`.github/workflows/release.yml`, `id-token: write`, `npm publish --provenance --access public`); no credentials stored in git or `.env` files.

---

## 4. Milestone 7.3 OWASP ASVS 5.0.0 Security Audit Sign-Off (2026-11-26)

Release candidate `v1.0.0-rc.1` completed a full end-to-end security review covering all 20 `@forge-fr/*` packages and Phase 2 hot-path optimizations:

| Audit Area | Verified Safeguard | Evidence | Status |
| :--- | :--- | :--- | :--- |
| **Hot-Path Body Limits (`@forge-fr/http`)** | `readBoundedJson` and `_readValidationBody` enforce `maxBodyBytes` across both declared `content-length` and streaming/chunked requests without `content-length`, returning `413 PayloadTooLargeError`. | `tests/security/asvs-audit.test.ts` + `packages/http/tests/body.test.ts` | **Signed Off** |
| **Header Injection Prevention (`@forge-fr/http`)** | `FastHeaders.set()` and `FastHeaders.append()` reject CR (`\r`), LF (`\n`), and NUL (`\0`) characters consistently with Web Standards `Headers`. | `tests/security/asvs-audit.test.ts` | **Signed Off** |
| **Lazy `requestId` & Spoof Resistance (`@forge-fr/http`)** | Untrusted incoming `x-request-id` headers are ignored unless `trustRequestId: true` is explicitly configured; error responses always emit server-generated correlation IDs while production mode strips internal stack traces and causes. | `tests/security/asvs-audit.test.ts` | **Signed Off** |
| **Prototype Pollution & Validation (`@forge-fr/http`, `@forge-fr/validation`, `@forge-fr/security`)** | Recursive forbidden-key scanning strips `__proto__`, `constructor`, and `prototype` in parsed JSON, query parameters, and validated inputs; unknown keys stripped by default. | `tests/security/asvs-audit.test.ts` + `fast-check` fuzz suites | **Signed Off** |
| **Web, Auth, AuthZ, Storage & Observability (`@forge-fr/auth`, `authorization`, `security`, `storage`, `logger`, `openapi`)** | Argon2id cross-runtime PHC hashing, `jose` strict algorithm allowlist (`alg: none` rejected), deny-overrides-allow RBAC & anti-IDOR/multi-tenant checks, boot-time CORS `*` + credentials rejection, CSRF, SSRF private/metadata blocking, symlink-jailed storage, XSS-escaped Swagger UI + strict CSP, and recursive log/secret redaction. | `tests/security/asvs-audit.test.ts` + package security suites | **Signed Off** |
| **Supply Chain & Packaging Provenance** | `bun audit` verified **0 vulnerabilities across 346 packages**; `npm pack` tarballs audited for zero leaked `src/`, `tests/`, `.env`, or placeholder metadata; `.github/workflows/release.yml` enforces OIDC provenance. | `scripts/verify-packaging.mjs` + `tests/packaging/packaging.test.ts` | **Signed Off** |
