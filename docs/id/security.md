# Panduan Keamanan ForgeJS (OWASP ASVS 5.0.0)

Keamanan di ForgeJS dibangun sebagai perilaku bawaan:

- **Perlindungan Header, CORS & CSRF:** Header pengamanan bawaan, penolakan otomatis kombinasi CORS wildcard `*` + `credentials: true` saat startup, dan token CSRF Web Crypto `timingSafeEqual`.
- **Sanitasi Input & Anti-Path Traversal:** Objek hasil parse diisolasi dengan `null` prototype dan dibersihkan dari `__proto__`, `constructor`, serta `prototype`; akses file dikurung dalam direktori dasar (`resolveConfinedPath`).
- **Pertahanan SSRF Outbound:** `validateOutboundUrl` dan `createSafeFetch` memblokir IP privat, loopback, metadata cloud (`169.254.169.254`), dan kebocoran kredensial saat redirect lintas origin.
- **Otorisasi Fail-Closed (`@forge-fr/authorization`):** Penolakan eksplisit selalu menang atas izin (*deny-overrides-allow*) serta pemisahan tenant otomatis.

## Contoh Penerapan Pertahanan Berlapis

```ts forge-example
import assert from 'node:assert/strict';
import { createHttpApp } from '@forge-fr/http';
import {
  PathTraversalError,
  createCorsMiddleware,
  createSecurityHeadersMiddleware,
  resolveConfinedPath,
} from '@forge-fr/security';
import { createTestClient } from '@forge-fr/testing';

assert.throws(
  () => resolveConfinedPath('/srv/uploads', '../../etc/passwd'),
  PathTraversalError,
);

const app = createHttpApp();
app.use(createSecurityHeadersMiddleware());
app.use(createCorsMiddleware({ origin: ['https://portal.contoh.id'], credentials: true }));
app.get('/aman', (ctx) => ctx.json({ status: 'terlindungi' }));

const client = createTestClient(app);
const res = await client.get('/aman', {
  headers: { origin: 'https://portal.contoh.id' },
});
assert.equal(res.status, 200);
assert.equal(res.headers.get('x-frame-options'), 'DENY');
assert.equal(res.headers.get('access-control-allow-origin'), 'https://portal.contoh.id');

await client.close();
```
