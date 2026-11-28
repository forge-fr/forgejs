import { ConfigurationError, isSecretValue } from '@forge-fr/core';
import type { StandardSchemaV1 } from '@standard-schema/spec';
import { parseDotEnv, type ParseDotEnvOptions } from './dotenv.js';
import { ConfigValidationError, type ConfigValidationIssue } from './errors.js';
import { buildSecretKeySet, isSecretConfigKey, sanitizeConfigMessage } from './redact.js';

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export type EnvSource = Readonly<Record<string, unknown>>;

export type ConfigOutput<TSchema extends StandardSchemaV1> = Readonly<
  StandardSchemaV1.InferOutput<TSchema>
>;

export interface DefineConfigOptions<TSchema extends StandardSchemaV1> {
  /** Standard Schema v1 schema (Zod, Valibot, ArkType, etc.). */
  readonly schema: TSchema;
  /** Explicit environment record (e.g. Cloudflare Workers `env` binding). Defaults to `process.env` when available. */
  readonly env?: EnvSource;
  /** Low-priority fallback values applied before dotenv and `env`. */
  readonly defaults?: EnvSource;
  /** Optional raw `.env` string content (or array of contents in ascending precedence). */
  readonly dotenvContent?: string | readonly string[];
  /** Options forwarded to `parseDotEnv()` when `dotenvContent` is provided. */
  readonly dotenvOptions?: ParseDotEnvOptions;
  /** Optional env var prefix (e.g. `"APP_"`). Matching keys are exposed without the prefix. */
  readonly prefix?: string;
  /** Additional key names or dot-paths treated as secrets in validation error output. */
  readonly secrets?: readonly string[];
  /** Deep-freeze the validated configuration object. Default: `true`. */
  readonly freeze?: boolean;
}

export interface LoadConfigOptions<TSchema extends StandardSchemaV1>
  extends DefineConfigOptions<TSchema> {
  /** Optional async or sync file paths to read via `fileReader` before validating. */
  readonly dotenvFiles?: readonly string[];
  /** Custom file reader returning `.env` text or `undefined` when missing. */
  readonly fileReader?: (filePath: string) => Promise<string | undefined> | string | undefined;
}

export interface ConfigLoader<TSchema extends StandardSchemaV1> {
  /** Synchronously validate an environment binding record (e.g. Cloudflare Workers `env`). */
  parse(env: EnvSource): ConfigOutput<TSchema>;
  /** Asynchronously validate an environment binding record (supports async schemas). */
  load(env: EnvSource): Promise<ConfigOutput<TSchema>>;
}

interface GlobalWithProcessEnv {
  readonly process?: {
    readonly env?: Readonly<Record<string, string | undefined>>;
  };
}

/**
 * Safely reads `process.env` when running on Node.js or Bun, returning an empty object
 * on Edge runtimes (Cloudflare Workers, Deno without compat, browsers) without throwing.
 */
export function readRuntimeEnv(): Readonly<Record<string, string | undefined>> {
  const proc = (globalThis as GlobalWithProcessEnv).process;
  if (proc && typeof proc.env === 'object' && proc.env !== null) {
    return proc.env;
  }
  return {};
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  if (isSecretValue(value) || value instanceof Date || value instanceof RegExp) {
    return false;
  }
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function deepFreeze<T>(value: T): T {
  if (Array.isArray(value)) {
    for (const item of value) {
      deepFreeze(item);
    }
    return Object.freeze(value);
  }
  if (isPlainRecord(value)) {
    for (const key of Object.keys(value)) {
      deepFreeze(value[key]);
    }
    return Object.freeze(value);
  }
  return value;
}

function assertSafeKeys(value: unknown, trail: string): void {
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      assertSafeKeys(value[i], `${trail}[${i}]`);
    }
    return;
  }
  if (!isPlainRecord(value)) {
    return;
  }
  for (const key of Object.keys(value)) {
    if (FORBIDDEN_KEYS.has(key)) {
      throw new ConfigurationError(
        `Forbidden configuration key "${key}" detected at "${trail || 'root'}"`,
      );
    }
    const nextTrail = trail ? `${trail}.${key}` : key;
    assertSafeKeys(value[key], nextTrail);
  }
}

function applySource(
  target: Record<string, unknown>,
  source: EnvSource | undefined,
  prefix: string | undefined,
): void {
  if (!source) {
    return;
  }
  for (const [rawKey, val] of Object.entries(source)) {
    if (val === undefined || FORBIDDEN_KEYS.has(rawKey)) {
      continue;
    }
    if (prefix !== undefined && prefix.length > 0) {
      if (rawKey.startsWith(prefix)) {
        const stripped = rawKey.slice(prefix.length);
        if (stripped.length > 0 && !FORBIDDEN_KEYS.has(stripped)) {
          target[stripped] = val;
        }
      }
    } else {
      target[rawKey] = val;
    }
  }
}

function buildMergedInput(
  options: {
    readonly defaults?: EnvSource;
    readonly dotenvContent?: string | readonly string[];
    readonly dotenvOptions?: ParseDotEnvOptions;
    readonly env?: EnvSource;
    readonly prefix?: string;
  },
  extraDotEnvLayers?: readonly Record<string, string>[],
): Record<string, unknown> {
  const merged: Record<string, unknown> = {};

  if (options.defaults !== undefined) {
    assertSafeKeys(options.defaults, '');
    applySource(merged, options.defaults, undefined);
  }

  if (extraDotEnvLayers) {
    for (const layer of extraDotEnvLayers) {
      applySource(merged, layer, options.prefix);
    }
  }

  if (options.dotenvContent !== undefined) {
    const contents = Array.isArray(options.dotenvContent)
      ? options.dotenvContent
      : [options.dotenvContent];
    for (const rawContent of contents) {
      const parsed = parseDotEnv(rawContent, options.dotenvOptions);
      applySource(merged, parsed, options.prefix);
    }
  }

  const runtimeEnv = options.env ?? readRuntimeEnv();
  applySource(merged, runtimeEnv, options.prefix);

  return merged;
}

function formatIssuePath(
  pathSegments: readonly (PropertyKey | StandardSchemaV1.PathSegment)[] | undefined,
): string {
  if (!pathSegments || pathSegments.length === 0) {
    return '';
  }
  const parts: string[] = [];
  for (const segment of pathSegments) {
    const key =
      typeof segment === 'object' && segment !== null && 'key' in segment
        ? segment.key
        : segment;
    parts.push(String(key));
  }
  return parts.join('.');
}

function mapStandardIssues(
  issues: readonly StandardSchemaV1.Issue[],
  extraSecrets?: readonly string[],
): ConfigValidationIssue[] {
  const secretSet = buildSecretKeySet(extraSecrets);
  return issues.map((issue) => {
    const pathStr = formatIssuePath(issue.path);
    const isSecret = isSecretConfigKey(pathStr, secretSet);
    const safeMessage = isSecret
      ? sanitizeConfigMessage(issue.message).replace(/received\s+"[^"]*"/gi, 'received "[REDACTED]"')
      : sanitizeConfigMessage(issue.message);
    return {
      path: pathStr,
      message: safeMessage,
      isSecret,
    };
  });
}

function finalizeResult<TSchema extends StandardSchemaV1>(
  result: StandardSchemaV1.Result<StandardSchemaV1.InferOutput<TSchema>>,
  options: { readonly secrets?: readonly string[]; readonly freeze?: boolean },
): ConfigOutput<TSchema> {
  if ('issues' in result && result.issues !== undefined) {
    throw new ConfigValidationError(mapStandardIssues(result.issues, options.secrets));
  }

  const validated = result.value;
  assertSafeKeys(validated, '');
  return (options.freeze !== false ? deepFreeze(validated) : validated) as ConfigOutput<TSchema>;
}

/**
 * Synchronously parses and validates environment configuration against any Standard Schema v1
 * schema (Zod, Valibot, ArkType, etc.), returning a deeply frozen, strictly typed config object.
 */
export function defineConfig<TSchema extends StandardSchemaV1>(
  options: DefineConfigOptions<TSchema>,
): ConfigOutput<TSchema> {
  if (!options.schema || typeof options.schema['~standard']?.validate !== 'function') {
    throw new ConfigurationError(
      'defineConfig() requires a Standard Schema v1 compatible schema (such as Zod v3.24+/v4 or Valibot v1)',
    );
  }

  const merged = buildMergedInput(options);
  const result = options.schema['~standard'].validate(merged);

  if (result instanceof Promise) {
    throw new ConfigurationError(
      'defineConfig() received an async Standard Schema validator. Use `await loadConfig(...)` instead.',
    );
  }

  return finalizeResult(result, options);
}

/**
 * Asynchronously loads optional `.env` layers and validates environment configuration
 * against any sync or async Standard Schema v1 schema.
 */
export async function loadConfig<TSchema extends StandardSchemaV1>(
  options: LoadConfigOptions<TSchema>,
): Promise<ConfigOutput<TSchema>> {
  if (!options.schema || typeof options.schema['~standard']?.validate !== 'function') {
    throw new ConfigurationError(
      'loadConfig() requires a Standard Schema v1 compatible schema (such as Zod v3.24+/v4 or Valibot v1)',
    );
  }

  const fileLayers: Record<string, string>[] = [];
  if (options.dotenvFiles && options.dotenvFiles.length > 0 && options.fileReader) {
    for (const filePath of options.dotenvFiles) {
      const content = await options.fileReader(filePath);
      if (typeof content === 'string') {
        fileLayers.push(parseDotEnv(content, options.dotenvOptions));
      }
    }
  }

  const merged = buildMergedInput(options, fileLayers);
  const result = await options.schema['~standard'].validate(merged);
  return finalizeResult(result, options);
}

/**
 * Creates a reusable, WeakMap-cached configuration loader ideal for Cloudflare Workers,
 * Deno, and multi-tenant runtimes where `env` bindings are supplied at request time.
 */
export function createConfigLoader<TSchema extends StandardSchemaV1>(
  options: Omit<DefineConfigOptions<TSchema>, 'env'> & { readonly cacheByEnvObject?: boolean },
): ConfigLoader<TSchema> {
  const useCache = options.cacheByEnvObject !== false;
  const cache = new WeakMap<object, ConfigOutput<TSchema>>();

  return {
    parse(env: EnvSource): ConfigOutput<TSchema> {
      if (useCache && typeof env === 'object' && env !== null) {
        const hit = cache.get(env);
        if (hit !== undefined) {
          return hit;
        }
      }
      const parsed = defineConfig({ ...options, env });
      if (useCache && typeof env === 'object' && env !== null) {
        cache.set(env, parsed);
      }
      return parsed;
    },

    async load(env: EnvSource): Promise<ConfigOutput<TSchema>> {
      if (useCache && typeof env === 'object' && env !== null) {
        const hit = cache.get(env);
        if (hit !== undefined) {
          return hit;
        }
      }
      const parsed = await loadConfig({ ...options, env });
      if (useCache && typeof env === 'object' && env !== null) {
        cache.set(env, parsed);
      }
      return parsed;
    },
  };
}
