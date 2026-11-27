# @forge-fr/logger

> Structured Pino logging with recursive secret redaction and CRLF neutralization, correlation IDs, OpenTelemetry W3C tracing/metrics, and sanitized /health/live & /health/ready routes.

- **Version**: v1.0.0-rc.1
- **Layer**: Infrastructure
- **Category**: infrastructure
- **Tarball**: 21.4 kB (32 files)
- **Internal deps**: @forge-fr/core, @forge-fr/http
- **Runtime deps**: pino ^10.4.0, @opentelemetry/api ^1.10.0
- **Peer deps**: none
- **HTML URL**: https://github.com/forge-fr/forgejs/api/logger
- **Markdown URL**: https://github.com/forge-fr/forgejs/api/logger.md

## Installation

```bash
npm install @forge-fr/logger
```

## Plugin Metadata

- **Factory**: `createObservabilityPlugin`
- **Tokens**: `ObservabilityTokens`
- **Health probe**: `observability:logger`
- **Capabilities**: `di:register`, `health:register`

## Runtime & Error Semantics

- **Runtime**: Uses pino ^10.4.0 and @opentelemetry/api ^1.10.0. Neutralizes CRLF log injection and redacts secrets recursively.
- **Errors**: /health/live and /health/ready endpoints sanitize check errors in production mode.

## Usage Example

```ts
import { createPinoLogger, createCorrelationIdMiddleware, registerHealthRoutes } from '@forge-fr/logger';

const logger = createPinoLogger({ serviceName: 'orders-api', level: 'info' });
logger.info('Service initialized');
```

## Public Exports

### Pino Logging, Redaction & Correlation

- **Values**: `DEFAULT_PINO_REDACT_PATHS`, `DEFAULT_REDACT_KEYS`, `buildRedactionSet`, `normalizeRedactKey`, `redactInlineSecrets`, `sanitizeLogContext`, `sanitizeLogMessage`, `createPinoLogger`, `createMemoryLogSink`, `createCorrelationIdMiddleware`, `createRequestLoggingMiddleware`, `attachObservabilityHooks`, `bindCorrelationId`, `getCorrelationId`, `getRequestLogger`, `isValidCorrelationId`, `resolveCorrelationId`
- **Types**: `ContextAccessor`, `CorrelationIdOptions`, `MemoryLogSink`, `ObservabilityHooksOptions`, `PinoForgeLogger`, `PinoLoggerOptions`, `RequestLoggingOptions`, `SanitizeContextOptions`

### OpenTelemetry, Health Routes & Plugin

- **Values**: `createOtelInstrumentation`, `createOtelHttpMiddleware`, `getActiveTraceContext`, `createLivenessHandler`, `createReadinessHandler`, `registerHealthRoutes`, `ObservabilityTokens`, `createObservabilityPlugin`
- **Types**: `ActiveTraceContext`, `HealthEndpointsOptions`, `HttpMetricRecord`, `ObservabilityPluginOptions`, `OtelHttpMiddlewareOptions`, `OtelInstrumentation`, `OtelInstrumentationOptions`, `SanitizedHealthCheck`, `SanitizedHealthPayload`
