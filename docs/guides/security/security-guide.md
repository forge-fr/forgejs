# Security Guide (OWASP ASVS 5.0.0)

> Clear breakdown of built-in HTTP protections, optional @forge-fr/security middleware, and what your team still owns.

- **Section**: Authentication & Security
- **Packages**: @forge-fr/security, @forge-fr/http, @forge-fr/storage, @forge-fr/logger
- **Version**: v1.0.0
- **Updated**: 2026-11-27
- **HTML URL**: https://github.com/forge-fr/forgejs/docs/security/security-guide
- **Markdown URL**: https://github.com/forge-fr/forgejs/docs/security/security-guide.md
- **Source**: https://github.com/forge-fr/forgejs/blob/main/docs/security-and-observability.md

## Ready-to-use OWASP ASVS 5.0.0 security controls

@forge-fr/security provides zero-dependency middleware and helper functions aligned with OWASP ASVS 5.0.0 security practices.

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

// Safe outbound fetch (blocks localhost, private IPs, and cloud metadata endpoints)
const safeFetch = createSafeFetch();
const safePath = resolveConfinedPath('/var/app/uploads', '2026/avatar.png');
const clean = sanitizeObject({ name: 'alice' });
```

## Built-in defaults vs. optional packages vs. your duties

| Layer | Included Controls |
| --- | --- |
| Built-in Framework Defaults | 1 MiB body size limit (413), safe route params, JSON prototype key stripping, hidden 5xx details, safe log line breaks, SecretValue masking |
| Optional @forge-fr/security & @forge-fr/auth | Security headers (CSP/HSTS), strict CORS, CSRF checks, rate limiting, SSRF-safe fetch, Argon2id passwords, strict JWTs, RBAC/ABAC |
| Your App & Infrastructure Duties | Calling ownership and tenant checks on every data fetch, HTTPS/TLS, WAF/DDoS protection, secret rotation, and container isolation |

## Honest security boundaries

> **SECURITY: Security Is a Shared Responsibility**
>
> No framework can make an app secure by itself. Plugins run in the same process (capabilities prevent accidental coupling, not OS sandboxing). Schema validation checks data shape only — your services must still verify ownership and tenant access.
