import {
  createToken,
  definePlugin,
  type ForgePlugin,
  type PluginContext,
} from '@forge-fr/core';
import {
  createApiKeyManager,
  type ApiKeyManager,
  type ApiKeyManagerOptions,
} from './api-key.js';
import type { BetterAuthInstanceLike } from './better-auth.js';
import { createJwtService, type JwtService, type JwtServiceOptions } from './jwt.js';
import {
  createArgon2PasswordHasher,
  type Argon2PasswordHasherOptions,
  type PasswordHasher,
} from './password.js';
import {
  createSessionManager,
  type SessionManager,
  type SessionManagerOptions,
} from './session.js';

export const AuthTokens = Object.freeze({
  passwordHasher: createToken<PasswordHasher>('AuthPasswordHasher'),
  jwt: createToken<JwtService>('AuthJwtService'),
  sessions: createToken<SessionManager>('AuthSessionManager'),
  apiKeys: createToken<ApiKeyManager>('AuthApiKeyManager'),
  betterAuth: createToken<BetterAuthInstanceLike>('AuthBetterAuthInstance'),
});

export interface AuthPluginConfig {
  readonly password?: Argon2PasswordHasherOptions | PasswordHasher;
  readonly jwt?: JwtServiceOptions | JwtService;
  readonly sessions?: SessionManagerOptions | SessionManager;
  readonly apiKeys?: ApiKeyManagerOptions | ApiKeyManager;
  readonly betterAuth?: BetterAuthInstanceLike;
}

export interface AuthPluginOptions {
  readonly name?: string;
  readonly version?: string;
  readonly forgeVersion?: string;
}

function isPasswordHasher(val: unknown): val is PasswordHasher {
  return (
    typeof val === 'object' &&
    val !== null &&
    'hash' in val &&
    typeof (val as { hash?: unknown }).hash === 'function' &&
    'verify' in val &&
    typeof (val as { verify?: unknown }).verify === 'function'
  );
}

function isJwtService(val: unknown): val is JwtService {
  return (
    typeof val === 'object' &&
    val !== null &&
    'sign' in val &&
    typeof (val as { sign?: unknown }).sign === 'function' &&
    'verify' in val &&
    typeof (val as { verify?: unknown }).verify === 'function'
  );
}

function isSessionManager(val: unknown): val is SessionManager {
  return (
    typeof val === 'object' &&
    val !== null &&
    'create' in val &&
    typeof (val as { create?: unknown }).create === 'function' &&
    'rotate' in val &&
    typeof (val as { rotate?: unknown }).rotate === 'function'
  );
}

function isApiKeyManager(val: unknown): val is ApiKeyManager {
  return (
    typeof val === 'object' &&
    val !== null &&
    'create' in val &&
    typeof (val as { create?: unknown }).create === 'function' &&
    'verify' in val &&
    typeof (val as { verify?: unknown }).verify === 'function' &&
    'revoke' in val &&
    typeof (val as { revoke?: unknown }).revoke === 'function'
  );
}

export function createAuthPlugin(
  options: AuthPluginOptions = {},
): ForgePlugin<AuthPluginConfig, AuthPluginConfig> {
  return definePlugin<AuthPluginConfig, AuthPluginConfig>({
    name: options.name ?? '@forge-fr/auth',
    version: options.version ?? '1.0.0',
    forgeVersion: options.forgeVersion ?? '^0.1.0 || ^1.0.0-rc.1 || ^1.0.0',
    capabilities: ['di:register'],

    register(ctx: PluginContext<AuthPluginConfig>, rawConfig: AuthPluginConfig | undefined): void {
      const config = rawConfig ?? {};

      const passwordHasher =
        config.password === undefined
          ? createArgon2PasswordHasher()
          : isPasswordHasher(config.password)
            ? config.password
            : createArgon2PasswordHasher(config.password);

      ctx.registerProvider(
        { token: AuthTokens.passwordHasher, useValue: passwordHasher },
        { export: true },
      );

      if (config.jwt !== undefined) {
        const jwtService = isJwtService(config.jwt)
          ? config.jwt
          : createJwtService(config.jwt);
        ctx.registerProvider(
          { token: AuthTokens.jwt, useValue: jwtService },
          { export: true },
        );
      }

      if (config.sessions !== undefined) {
        const sessionManager = isSessionManager(config.sessions)
          ? config.sessions
          : createSessionManager(config.sessions);
        ctx.registerProvider(
          { token: AuthTokens.sessions, useValue: sessionManager },
          { export: true },
        );
      }

      if (config.apiKeys !== undefined) {
        const apiKeyManager = isApiKeyManager(config.apiKeys)
          ? config.apiKeys
          : createApiKeyManager(config.apiKeys);
        ctx.registerProvider(
          { token: AuthTokens.apiKeys, useValue: apiKeyManager },
          { export: true },
        );
      }

      if (config.betterAuth !== undefined) {
        ctx.registerProvider(
          { token: AuthTokens.betterAuth, useValue: config.betterAuth },
          { export: true },
        );
      }
    },
  });
}
