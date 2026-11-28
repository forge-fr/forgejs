import { createToken, definePlugin, type ForgePlugin } from '@forge-fr/core';
import type { ForgeMiddleware } from '@forge-fr/http';
import {
  createCorrelationIdMiddleware,
  createRequestLoggingMiddleware,
  type CorrelationIdOptions,
  type RequestLoggingOptions,
} from './correlation.js';
import {
  createPinoLogger,
  type PinoForgeLogger,
  type PinoLoggerOptions,
} from './pino-logger.js';
import {
  createOtelHttpMiddleware,
  createOtelInstrumentation,
  type OtelHttpMiddlewareOptions,
  type OtelInstrumentation,
  type OtelInstrumentationOptions,
} from './telemetry.js';

export const ObservabilityTokens = Object.freeze({
  Logger: createToken<PinoForgeLogger>('@forge-fr/logger:Logger'),
  Telemetry: createToken<OtelInstrumentation>('@forge-fr/logger:Telemetry'),
  CorrelationMiddleware: createToken<ForgeMiddleware>('@forge-fr/logger:CorrelationMiddleware'),
  RequestLoggingMiddleware: createToken<ForgeMiddleware>('@forge-fr/logger:RequestLoggingMiddleware'),
  TelemetryMiddleware: createToken<ForgeMiddleware>('@forge-fr/logger:TelemetryMiddleware'),
});

export interface ObservabilityPluginOptions {
  readonly serviceName?: string;
  readonly serviceVersion?: string;
  readonly logger?: PinoLoggerOptions;
  readonly telemetry?: OtelInstrumentationOptions;
  readonly correlation?: CorrelationIdOptions;
  readonly requestLogging?: Omit<RequestLoggingOptions, 'logger'>;
  readonly telemetryMiddleware?: Omit<OtelHttpMiddlewareOptions, 'instrumentation'>;
  /** Register an `observability:logger` self-check in `ctx.health`. Default: `true`. */
  readonly registerHealthCheck?: boolean;
}

export function createObservabilityPlugin(
  options: ObservabilityPluginOptions = {},
): ForgePlugin<undefined, undefined> {
  let activeLogger: PinoForgeLogger | undefined;

  return definePlugin({
    name: '@forge-fr/logger',
    version: '1.0.0',
    forgeVersion: '^0.1.0 || ^1.0.0-rc.1 || ^1.0.0',
    capabilities: ['di:register', 'health:register'],
    register(ctx) {
      const telemetry = createOtelInstrumentation({
        ...(options.serviceName !== undefined ? { serviceName: options.serviceName } : {}),
        ...(options.serviceVersion !== undefined ? { serviceVersion: options.serviceVersion } : {}),
        ...(options.telemetry ?? {}),
      });

      const logger = createPinoLogger({
        ...(options.serviceName !== undefined ? { name: options.serviceName } : {}),
        traceContextProvider: () => telemetry.getActiveTraceContext(),
        ...(options.logger ?? {}),
      });
      activeLogger = logger;

      const correlationMw = createCorrelationIdMiddleware(options.correlation);
      const requestLoggingMw = createRequestLoggingMiddleware({
        logger,
        ...(options.requestLogging ?? {}),
      });
      const telemetryMw = createOtelHttpMiddleware({
        instrumentation: telemetry,
        ...(options.telemetryMiddleware ?? {}),
      });

      ctx.registerProvider(
        { token: ObservabilityTokens.Logger, useValue: logger },
        { export: true },
      );
      ctx.registerProvider(
        { token: ObservabilityTokens.Telemetry, useValue: telemetry },
        { export: true },
      );
      ctx.registerProvider(
        { token: ObservabilityTokens.CorrelationMiddleware, useValue: correlationMw },
        { export: true },
      );
      ctx.registerProvider(
        { token: ObservabilityTokens.RequestLoggingMiddleware, useValue: requestLoggingMw },
        { export: true },
      );
      ctx.registerProvider(
        { token: ObservabilityTokens.TelemetryMiddleware, useValue: telemetryMw },
        { export: true },
      );

      if (options.registerHealthCheck !== false) {
        ctx.registerHealthCheck('observability:logger', () => ({
          status: 'ok',
          details: { level: logger.level },
        }));
      }
    },
    async onShutdown() {
      if (activeLogger) {
        await activeLogger.flush();
      }
    },
  });
}
