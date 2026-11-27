import {
  createToken,
  definePlugin,
  type ForgePlugin,
  type HealthCheckResult,
} from '@forge-fr/core';
import { generateOpenApiDocument } from './generator.js';
import { registerOpenApiRoutes } from './swagger.js';
import type { OpenApiDocument, OpenApiPluginOptions } from './types.js';

export const OpenApiTokens = Object.freeze({
  Document: createToken<OpenApiDocument>('@forge-fr/openapi:Document'),
});

export function createOpenApiPlugin(
  options: OpenApiPluginOptions,
): ForgePlugin<undefined, undefined> {
  const healthCheckName = options.healthCheckName ?? 'openapi';

  return definePlugin({
    name: '@forge-fr/openapi',
    version: '1.0.0-rc.1',
    forgeVersion: '^0.1.0 || ^1.0.0-rc.1',
    capabilities: ['di:register', 'health:register'],
    register(ctx) {
      if (options.app && options.registerRoutes !== false && options.enabled !== false) {
        registerOpenApiRoutes(options.app, options);
      }

      ctx.registerProvider(
        {
          token: OpenApiTokens.Document,
          useFactory: () =>
            options.app
              ? generateOpenApiDocument(options.app, options)
              : {
                  openapi: '3.1.0',
                  info: {
                    title: options.title,
                    version: options.version,
                    ...(options.description !== undefined
                      ? { description: options.description }
                      : {}),
                  },
                  paths: {},
                },
          scope: 'singleton',
        },
        { export: true },
      );

      if (options.registerHealthCheck !== false) {
        ctx.registerHealthCheck(healthCheckName, (): HealthCheckResult => ({
          status: 'ok',
          details: {
            title: options.title,
            version: options.version,
            enabled: options.enabled !== false,
          },
        }));
      }
    },
  });
}
