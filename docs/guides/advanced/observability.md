# Logging, Metrics, Tracing & Health Checks

> Structured JSON logging with automatic secret masking, correlation IDs, OpenTelemetry tracing, and /health/live & /health/ready endpoints.

- **Section**: Advanced Features
- **Packages**: @forge-fr/logger
- **Version**: v1.0.0
- **Updated**: 2026-11-27
- **HTML URL**: https://github.com/forge-fr/forgejs/docs/advanced/observability
- **Markdown URL**: https://github.com/forge-fr/forgejs/docs/advanced/observability.md
- **Source**: https://github.com/forge-fr/forgejs/blob/main/docs/security-and-observability.md

## Safe structured logs, request IDs & health probes

@forge-fr/logger automatically hides SecretValue fields, passwords, tokens, and database URL credentials, cleans unsafe line breaks from log messages, passes x-correlation-id headers, and registers production-safe health endpoints.

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

Add createObservabilityPlugin() or createTelemetryMiddleware() to export OpenTelemetry traces and HTTP latency metrics without tying your business logic to a specific monitoring vendor.
