# Security & Observability

## 1. Security Headers, CORS, Input Sanitization & SSRF Protection (`@forge-fr/security`)

`@forge-fr/security` ships hardened defaults without third-party dependencies:

```ts forge-example
import assert from 'node:assert/strict';
import { createHttpApp } from '@forge-fr/http';
import {
  SsrfBlockedError,
  createCorsMiddleware,
  createSecurityHeadersMiddleware,
  resolveConfinedPath,
  sanitizeObject,
  validateOutboundUrl,
} from '@forge-fr/security';
import { createTestClient } from '@forge-fr/testing';

const safePayload = sanitizeObject(
  JSON.parse('{"name":"alice","__proto__":{"polluted":true}}') as Record<string, unknown>,
);
assert.equal(Object.getPrototypeOf(safePayload), null);
assert.equal(safePayload['name'], 'alice');
assert.equal(({} as Record<string, unknown>)['polluted'], undefined);

assert.equal(resolveConfinedPath('/var/app/uploads', '2026/avatar.png'), '/var/app/uploads/2026/avatar.png');

await assert.rejects(
  () => validateOutboundUrl('http://169.254.169.254/latest/meta-data/'),
  SsrfBlockedError,
);

const app = createHttpApp();
app.use(createSecurityHeadersMiddleware());
app.use(createCorsMiddleware({ origin: ['https://app.example.com'], credentials: true }));
app.get('/ping', (ctx) => ctx.json({ ok: true }));

const client = createTestClient(app);
const res = await client.get('/ping', {
  headers: { origin: 'https://app.example.com' },
});
assert.equal(res.status, 200);
assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
assert.equal(res.headers.get('access-control-allow-origin'), 'https://app.example.com');
await client.close();
```

## 2. Structured Logging, Redaction, Correlation & Health Probes (`@forge-fr/logger`)

`@forge-fr/logger` redacts secrets and credentialed URLs recursively, neutralizes CRLF characters in logs, attaches correlation IDs, and serves production-safe `/health/live` and `/health/ready` endpoints:

```ts forge-example
import assert from 'node:assert/strict';
import { secret } from '@forge-fr/core';
import { createHttpApp } from '@forge-fr/http';
import {
  createCorrelationIdMiddleware,
  createMemoryLogSink,
  createPinoLogger,
  registerHealthRoutes,
} from '@forge-fr/logger';
import { createTestClient } from '@forge-fr/testing';

const sink = createMemoryLogSink();
const logger = createPinoLogger({ destination: sink.stream });

logger.info('db.connect\r\nforged-line', {
  databaseUrl: 'postgres://user:secretpass@db.local:5432/app',
  apiKey: secret('sk_live_very_secret_value'),
});

const entry = sink.entries()[0] as Record<string, unknown>;
assert.ok(String(entry['msg']).includes('db.connect'));
assert.ok(!String(entry['msg']).includes('\r'));
assert.ok(!JSON.stringify(entry).includes('secretpass'));
assert.ok(!JSON.stringify(entry).includes('sk_live_very_secret_value'));

const app = createHttpApp();
app.use(createCorrelationIdMiddleware());
registerHealthRoutes(app, { registry: app.kernel.health });

const client = createTestClient(app);
const live = await client.get('/health/live');
assert.equal(live.status, 200);
assert.ok(live.headers.get('x-correlation-id'));
await client.close();
```
