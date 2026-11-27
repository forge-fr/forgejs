import {
  createToken,
  definePlugin,
  type ForgePlugin,
  type PluginContext,
} from '@forge-fr/core';
import type { ForgeMiddleware } from '@forge-fr/http';
import { createCorsMiddleware, type CorsOptions } from './cors.js';
import { createCsrfMiddleware, type CsrfMiddlewareOptions } from './csrf.js';
import {
  createSecurityHeadersMiddleware,
  type SecurityHeadersOptions,
} from './headers.js';
import {
  createMemoryRateLimitStore,
  createRateLimitMiddleware,
  type RateLimitMiddlewareOptions,
  type RateLimitStore,
} from './rate-limit.js';
import { createSafeFetch, type SafeFetch, type SafeFetchOptions } from './ssrf.js';

export const SecurityTokens = Object.freeze({
  rateLimitStore: createToken<RateLimitStore>('SecurityRateLimitStore'),
  safeFetch: createToken<SafeFetch>('SecuritySafeFetch'),
  headersMiddleware: createToken<ForgeMiddleware>('SecurityHeadersMiddleware'),
  corsMiddleware: createToken<ForgeMiddleware>('SecurityCorsMiddleware'),
  csrfMiddleware: createToken<ForgeMiddleware>('SecurityCsrfMiddleware'),
  rateLimitMiddleware: createToken<ForgeMiddleware>('SecurityRateLimitMiddleware'),
});

export interface SecurityPluginConfig {
  readonly headers?: SecurityHeadersOptions;
  readonly cors?: CorsOptions;
  readonly csrf?: CsrfMiddlewareOptions;
  readonly rateLimit?: RateLimitMiddlewareOptions;
  readonly ssrf?: SafeFetchOptions;
}

export interface SecurityPluginOptions {
  readonly name?: string;
  readonly version?: string;
  readonly forgeVersion?: string;
}

export function createSecurityPlugin(
  options: SecurityPluginOptions = {},
): ForgePlugin<SecurityPluginConfig, SecurityPluginConfig> {
  return definePlugin<SecurityPluginConfig, SecurityPluginConfig>({
    name: options.name ?? '@forge-fr/security',
    version: options.version ?? '1.0.0-rc.1',
    forgeVersion: options.forgeVersion ?? '^0.1.0 || ^1.0.0-rc.1',
    capabilities: ['di:register'],

    register(
      ctx: PluginContext<SecurityPluginConfig>,
      rawConfig: SecurityPluginConfig | undefined,
    ): void {
      const config = rawConfig ?? {};

      const rateLimitStore = config.rateLimit?.store ?? createMemoryRateLimitStore();
      const safeFetch = createSafeFetch(config.ssrf);
      const headersMiddleware = createSecurityHeadersMiddleware(config.headers);

      ctx.registerProvider(
        { token: SecurityTokens.rateLimitStore, useValue: rateLimitStore },
        { export: true },
      );
      ctx.registerProvider(
        { token: SecurityTokens.safeFetch, useValue: safeFetch },
        { export: true },
      );
      ctx.registerProvider(
        { token: SecurityTokens.headersMiddleware, useValue: headersMiddleware },
        { export: true },
      );

      if (config.cors !== undefined) {
        ctx.registerProvider(
          { token: SecurityTokens.corsMiddleware, useValue: createCorsMiddleware(config.cors) },
          { export: true },
        );
      }

      if (config.csrf !== undefined) {
        ctx.registerProvider(
          { token: SecurityTokens.csrfMiddleware, useValue: createCsrfMiddleware(config.csrf) },
          { export: true },
        );
      }

      if (config.rateLimit !== undefined) {
        ctx.registerProvider(
          {
            token: SecurityTokens.rateLimitMiddleware,
            useValue: createRateLimitMiddleware({ ...config.rateLimit, store: rateLimitStore }),
          },
          { export: true },
        );
      }
    },
  });
}
