import {
  createToken,
  definePlugin,
  type ForgePlugin,
  type PluginContext,
} from '@forge-fr/core';
import type { ForgeHttpApp, ForgeMiddleware } from '@forge-fr/http';
import {
  attachSecurity,
  createSecurityMiddleware,
  type SecurityMiddlewareOptions,
} from './compose.js';
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
  securityMiddleware: createToken<ForgeMiddleware>('SecurityMiddleware'),
});

export interface SecurityPluginConfig {
  readonly headers?: SecurityHeadersOptions | false;
  readonly cors?: CorsOptions;
  readonly csrf?: CsrfMiddlewareOptions;
  readonly rateLimit?: RateLimitMiddlewareOptions;
  readonly ssrf?: SafeFetchOptions;
  readonly rateLimitPreflight?: boolean;
  /** Optional HTTP app to automatically attach the unified security stack and CORS preflight hook. */
  readonly app?: ForgeHttpApp;
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
    version: options.version ?? '1.0.0',
    forgeVersion: options.forgeVersion ?? '^0.1.0 || ^1.0.0-rc.1 || ^1.0.0',
    capabilities: ['di:register'],

    register(
      ctx: PluginContext<SecurityPluginConfig>,
      rawConfig: SecurityPluginConfig | undefined,
    ): void {
      const config = rawConfig ?? {};

      const rateLimitStore =
        config.rateLimit?.store ??
        createMemoryRateLimitStore({
          ...(config.rateLimit?.algorithm !== undefined
            ? { algorithm: config.rateLimit.algorithm }
            : {}),
          ...(config.rateLimit?.now !== undefined ? { now: config.rateLimit.now } : {}),
        });
      const safeFetch = createSafeFetch(config.ssrf);

      ctx.registerProvider(
        { token: SecurityTokens.rateLimitStore, useValue: rateLimitStore },
        { export: true },
      );
      ctx.registerProvider(
        { token: SecurityTokens.safeFetch, useValue: safeFetch },
        { export: true },
      );

      if (config.headers !== false) {
        const headersMiddleware = createSecurityHeadersMiddleware(config.headers);
        ctx.registerProvider(
          { token: SecurityTokens.headersMiddleware, useValue: headersMiddleware },
          { export: true },
        );
      }

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

      const resolvedRateLimit: RateLimitMiddlewareOptions | undefined =
        config.rateLimit !== undefined ? { ...config.rateLimit, store: rateLimitStore } : undefined;

      if (resolvedRateLimit !== undefined) {
        ctx.registerProvider(
          {
            token: SecurityTokens.rateLimitMiddleware,
            useValue: createRateLimitMiddleware(resolvedRateLimit),
          },
          { export: true },
        );
      }

      const composeOptions: SecurityMiddlewareOptions = {
        ...(config.headers !== undefined ? { headers: config.headers } : {}),
        ...(config.cors !== undefined ? { cors: config.cors } : {}),
        ...(resolvedRateLimit !== undefined ? { rateLimit: resolvedRateLimit } : {}),
        ...(config.csrf !== undefined ? { csrf: config.csrf } : {}),
        ...(config.rateLimitPreflight !== undefined
          ? { rateLimitPreflight: config.rateLimitPreflight }
          : {}),
      };

      const securityMiddleware = createSecurityMiddleware(composeOptions);
      ctx.registerProvider(
        { token: SecurityTokens.securityMiddleware, useValue: securityMiddleware },
        { export: true },
      );

      if (config.app !== undefined) {
        attachSecurity(config.app, composeOptions);
      }
    },
  });
}
