export {
  DEFAULT_PINO_REDACT_PATHS,
  DEFAULT_REDACT_KEYS,
  buildRedactionSet,
  normalizeRedactKey,
  redactInlineSecrets,
  sanitizeLogContext,
  sanitizeLogMessage,
  type SanitizeContextOptions,
} from './redact.js';

export {
  createMemoryLogSink,
  createPinoLogger,
  type MemoryLogSink,
  type PinoForgeLogger,
  type PinoLoggerOptions,
} from './pino-logger.js';

export {
  attachObservabilityHooks,
  bindCorrelationId,
  createCorrelationIdMiddleware,
  createRequestLoggingMiddleware,
  getCorrelationId,
  getRequestLogger,
  isValidCorrelationId,
  resolveCorrelationId,
  type CorrelationIdOptions,
  type ObservabilityHooksOptions,
  type RequestLoggingOptions,
} from './correlation.js';

export {
  createOtelHttpMiddleware,
  createOtelInstrumentation,
  getActiveTraceContext,
  type ActiveTraceContext,
  type ContextAccessor,
  type HttpMetricRecord,
  type OtelHttpMiddlewareOptions,
  type OtelInstrumentation,
  type OtelInstrumentationOptions,
} from './telemetry.js';

export {
  createLivenessHandler,
  createReadinessHandler,
  registerHealthRoutes,
  type HealthEndpointsOptions,
  type SanitizedHealthCheck,
  type SanitizedHealthPayload,
} from './health.js';

export {
  ObservabilityTokens,
  createObservabilityPlugin,
  type ObservabilityPluginOptions,
} from './plugin.js';
