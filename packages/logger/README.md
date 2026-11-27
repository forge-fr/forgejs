# @forge-fr/logger

Structured logging, request correlation, OpenTelemetry instrumentation, and health endpoints for **ForgeJS** running natively on **Node.js 22+/24+** and **Bun 1.4+**.

## Features

- **Pino-Backed `ForgeLogger`:** High-performance JSON structured logging implementing `@forge-fr/core`'s `ForgeLogger` contract with graceful `flush()` support.
- **Automatic Secret & PII Redaction:** Recursively redacts `SecretValue`, sensitive keys (`authorization`, `cookie`, `password`, `token`, `apiKey`, `secret`, etc.), embedded database URL credentials, inline Bearer/Basic tokens, and neutralizes CRLF log injection.
- **Request Correlation & Access Logging:** Safe correlation ID propagation (`createCorrelationIdMiddleware`) and structured request completion logging (`createRequestLoggingMiddleware`) with slow-request warnings and header allowlisting.
- **OpenTelemetry (`@opentelemetry/api`) Hooks:** Automatic `trace_id`/`span_id` injection into Pino logs, `withSpan()` helper, W3C `traceparent` extraction, HTTP server spans, and standard HTTP metrics (`http.server.requests`, `http.server.request.duration`, `http.server.active_requests`).
- **Liveness & Readiness Health Endpoints:** Production-safe `/health/live` and `/health/ready` handlers wired directly to `kernel.health` with timeout protection, `Cache-Control: no-store`, and secret-safe detail redaction.
- **ForgeJS DI Plugin:** `createObservabilityPlugin()` exporting logger, telemetry instrumentation, and HTTP middleware with automatic log flush on kernel shutdown.
