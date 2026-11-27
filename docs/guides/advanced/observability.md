# Logging, Metrics, Tracing & Health Checks

> Structured Pino logging with secret & URL redaction, CRLF neutralization, correlation IDs, OpenTelemetry tracing/metrics, and sanitized /health/live & /health/ready endpoints.

- **Section**: Advanced Features
- **Packages**: @forge-fr/logger
- **Version**: v1.0.0-rc.1
- **Updated**: 2026-11-26
- **HTML URL**: https://github.com/forge-fr/forgejs/docs/advanced/observability
- **Markdown URL**: https://github.com/forge-fr/forgejs/docs/advanced/observability.md
- **Source**: https://github.com/forge-fr/forgejs/blob/main/docs/security-and-observability.md

## Redacted Pino logging, correlation IDs & health probes

@forge-fr/logger automatically redacts SecretValue objects, password/token keys, and credentialed database URLs, strips CRLF log-injection newlines, propagates x-correlation-id headers, and serves production-safe health endpoints.

**File: `src/observability.ts`**

```ts
import { secret } from '@forge-fr/core';
import { createHttpApp } from '@forge-fr/http';
import {
  createCorrelationIdMiddleware,
  createMemoryLogSink,
  createPinoLogger,
  registerHealthRoutes,
} from '@forge-fr/logger';

const sink = createMemoryLogSink();
const logger = createPinoLogger({ destination: sink.stream });

logger.info('db.connect', {
  databaseUrl: 'postgres://user:secretpass@db.local:5432/app',
  apiKey: secret('sk_live_very_secret_value'),
});

const app = createHttpApp();
app.use(createCorrelationIdMiddleware());
registerHealthRoutes(app, { registry: app.kernel.health });
```

## OpenTelemetry tracing & metrics

Mount createObservabilityPlugin() or createTelemetryMiddleware() to connect @opentelemetry/api tracer spans and HTTP latency histograms without hard-coupling your domain layer to a specific APM vendor.
