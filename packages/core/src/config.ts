import { ConfigurationError } from './errors.js';
import { REDACTED_PLACEHOLDER, isSecretValue } from './secret.js';

const FORBIDDEN_KEYS: ReadonlySet<string> = new Set([
  '__proto__',
  'constructor',
  'prototype',
]);

export interface ConfigManagerOptions<TConfig extends Record<string, unknown>> {
  readonly defaults?: Record<string, unknown>;
  readonly values?: Record<string, unknown>;
  readonly validate?: (raw: Record<string, unknown>) => TConfig;
}

export interface ConfigManager<TConfig extends Record<string, unknown> = Record<string, unknown>> {
  get<TValue = unknown>(path: string): TValue | undefined;
  getOrThrow<TValue = unknown>(path: string): TValue;
  has(path: string): boolean;
  toObject(): Readonly<TConfig>;
  toSafeObject(): Record<string, unknown>;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  if (isSecretValue(value) || value instanceof Date || value instanceof RegExp) {
    return false;
  }
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function assertSafeKeys(value: unknown, trail: string): void {
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      assertSafeKeys(value[i], `${trail}[${i}]`);
    }
    return;
  }

  if (!isPlainObject(value)) {
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

function deepMerge(
  base: Record<string, unknown>,
  override: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const key of Object.keys(base)) {
    if (FORBIDDEN_KEYS.has(key)) {
      throw new ConfigurationError(`Forbidden configuration key "${key}"`);
    }
    const baseVal = base[key];
    result[key] = isPlainObject(baseVal) ? deepMerge(baseVal, {}) : baseVal;
  }

  for (const key of Object.keys(override)) {
    if (FORBIDDEN_KEYS.has(key)) {
      throw new ConfigurationError(`Forbidden configuration key "${key}"`);
    }
    const overrideVal = override[key];
    const existingVal = result[key];
    if (isPlainObject(existingVal) && isPlainObject(overrideVal)) {
      result[key] = deepMerge(existingVal, overrideVal);
    } else if (isPlainObject(overrideVal)) {
      result[key] = deepMerge(overrideVal, {});
    } else if (overrideVal !== undefined) {
      result[key] = overrideVal;
    }
  }

  return result;
}

function deepFreeze<T>(value: T): T {
  if (Array.isArray(value)) {
    for (const item of value) {
      deepFreeze(item);
    }
    return Object.freeze(value);
  }

  if (isPlainObject(value)) {
    for (const key of Object.keys(value)) {
      deepFreeze(value[key]);
    }
    return Object.freeze(value);
  }

  return value;
}

function redactConfigObject(value: unknown): unknown {
  if (isSecretValue(value)) {
    return REDACTED_PLACEHOLDER;
  }
  if (Array.isArray(value)) {
    return value.map(redactConfigObject);
  }
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = redactConfigObject(v);
    }
    return out;
  }
  return value;
}

function resolvePath(root: Record<string, unknown>, dotPath: string): { found: boolean; value: unknown } {
  const segments = dotPath.split('.').filter((s) => s.length > 0);
  if (segments.length === 0) {
    return { found: false, value: undefined };
  }

  let current: unknown = root;
  for (const segment of segments) {
    if (FORBIDDEN_KEYS.has(segment)) {
      return { found: false, value: undefined };
    }
    if (!isPlainObject(current) || !Object.prototype.hasOwnProperty.call(current, segment)) {
      return { found: false, value: undefined };
    }
    current = current[segment];
  }

  return { found: true, value: current };
}

export function createConfigManager<
  TConfig extends Record<string, unknown> = Record<string, unknown>,
>(options: ConfigManagerOptions<TConfig> = {}): ConfigManager<TConfig> {
  if (options.defaults !== undefined) {
    assertSafeKeys(options.defaults, '');
  }
  if (options.values !== undefined) {
    assertSafeKeys(options.values, '');
  }

  const merged = deepMerge(options.defaults ?? {}, options.values ?? {});

  let validated: TConfig;
  if (options.validate !== undefined) {
    try {
      validated = options.validate(merged);
      assertSafeKeys(validated, '');
    } catch (err: unknown) {
      if (err instanceof ConfigurationError) {
        throw err;
      }
      const message = err instanceof Error ? err.message : 'Configuration validation failed';
      throw new ConfigurationError(message, { cause: err });
    }
  } else {
    validated = merged as TConfig;
  }

  const frozen = deepFreeze(validated);

  return {
    get<TValue = unknown>(path: string): TValue | undefined {
      const resolved = resolvePath(frozen, path);
      return resolved.found ? (resolved.value as TValue) : undefined;
    },

    getOrThrow<TValue = unknown>(path: string): TValue {
      const resolved = resolvePath(frozen, path);
      if (!resolved.found || resolved.value === undefined) {
        throw new ConfigurationError(`Missing required configuration key "${path}"`);
      }
      return resolved.value as TValue;
    },

    has(path: string): boolean {
      const resolved = resolvePath(frozen, path);
      return resolved.found && resolved.value !== undefined;
    },

    toObject(): Readonly<TConfig> {
      return frozen;
    },

    toSafeObject(): Record<string, unknown> {
      return redactConfigObject(frozen) as Record<string, unknown>;
    },
  };
}
