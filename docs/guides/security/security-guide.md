# Security Guide (OWASP ASVS 5.0.0)

> Clear separation of built-in HTTP defaults, optional @forge-fr/security middleware, and application/infrastructure security responsibilities.

- **Section**: Authentication & Security
- **Packages**: @forge-fr/security, @forge-fr/http, @forge-fr/storage, @forge-fr/logger
- **Version**: v1.0.0-rc.1
- **Updated**: 2026-11-26
- **HTML URL**: https://github.com/forge-fr/forgejs/docs/security/security-guide
- **Markdown URL**: https://github.com/forge-fr/forgejs/docs/security/security-guide.md
- **Source**: https://github.com/forge-fr/forgejs/blob/main/docs/security-and-observability.md

## Composable OWASP ASVS 5.0.0 controls

@forge-fr/security ships zero-dependency security middleware and utility guards aligned with OWASP ASVS 5.0.0 L1/L2 baseline controls.

**File: `src/security.ts`**

```ts
import { createHttpApp } from '@forge-fr/http';
import {
  createCorsMiddleware,
  createCsrfMiddleware,
  createRateLimitMiddleware,
  createSafeFetch,
  createSecurityHeadersMiddleware,
  resolveConfinedPath,
  sanitizeObject,
} from '@forge-fr/security';

const app = createHttpApp();
app.use(createSecurityHeadersMiddleware());
app.use(createCorsMiddleware({ origin: ['https://app.example.com'], credentials: true }));
app.use(createCsrfMiddleware());
app.use(createRateLimitMiddleware({ windowMs: 60_000, max: 120, trustProxy: false }));

// SSRF-hardened outbound fetch (blocks loopback, link-local, RFC1918, cloud metadata)
const safeFetch = createSafeFetch();
const safePath = resolveConfinedPath('/var/app/uploads', '2026/avatar.png');
const clean = sanitizeObject({ name: 'alice' });
```

## Built-in defaults vs. optional vs. application duties

| Layer | Included Controls |
| --- | --- |
| Built-in Framework Defaults | 1 MiB bounded body readers (413), null-prototype params, prototype-pollution stripping, expose: false 5xx sanitization, CRLF log stripping, SecretValue redaction |
| Optional @forge-fr/security & @forge-fr/auth | CSP/HSTS headers, strict CORS, double-submit CSRF, rate limiting, SSRF createSafeFetch(), Argon2id, algorithm-pinned JWT, RBAC/ABAC |
| Application & Infrastructure Duties | Calling assertOwnership() & assertTenantIsolation() on every object fetch, TLS termination, WAF/DDoS, secret rotation, OS/container isolation |

## Limitations & honest boundaries

> **SECURITY: Honest Security Boundary**
>
> No framework automatically makes an application secure. Plugins run in-process (capability scoping prevents accidental coupling, not OS/VM sandboxing). Schema validation proves shape only; services must still enforce ownership and tenant checks.
