# Changelog

## 0.1.0 (2026-11-25)

- Initial release of `@forge-fr/logger`:
  - Pino-backed `ForgeLogger` (`createPinoLogger`, `createMemoryLogSink`) with automatic recursive secret/PII redaction, credential URL redaction, and CRLF log-injection protection.
  - Request correlation ID & structured HTTP access logging middleware (`createCorrelationIdMiddleware`, `getCorrelationId`, `createRequestLoggingMiddleware`, `getRequestLogger`).
  - OpenTelemetry (`@opentelemetry/api`) tracing & metrics integration (`getActiveTraceContext`, `createOtelInstrumentation`, `createOtelHttpMiddleware`).
  - Production-safe liveness & readiness health endpoints (`createLivenessHandler`, `createReadinessHandler`, `registerHealthRoutes`) wired to `@forge-fr/core` `HealthRegistry`.
  - ForgeJS DI plugin (`createObservabilityPlugin`, `ObservabilityTokens`) with graceful log flush on shutdown.
