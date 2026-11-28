import { REDACTED_PLACEHOLDER, isSecretValue } from '@forge-fr/core';

const SECRET_KEY_PATTERN =
  /(?:^|[_.-])(secret|password|passwd|pwd|token|key|apikey|api_key|passphrase|credential|credentials|private|dsn|database_url|databaseurl|connection_string|connectionstring|auth|cookie|signing)(?:$|[_.-])/i;

const CREDENTIALED_URL_REGEX =
  /\b(postgres|postgresql|mysql|mariadb|mongodb(?:\+srv)?|redis|rediss|amqp|amqps|https?):\/\/([^:/@\s]+):([^@\s]+)@/gi;

export interface RedactConfigOptions {
  /** Additional key names or dot-paths that must always be redacted. */
  readonly secrets?: readonly string[];
}

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[-_]/g, '');
}

export function buildSecretKeySet(extraSecrets?: readonly string[]): ReadonlySet<string> {
  const set = new Set<string>();
  if (extraSecrets) {
    for (const s of extraSecrets) {
      const trimmed = s.trim();
      if (trimmed.length > 0) {
        set.add(trimmed.toLowerCase());
        set.add(normalizeKey(trimmed));
      }
    }
  }
  return set;
}

export function isSecretConfigKey(
  keyOrPath: string,
  extraSecretSet?: ReadonlySet<string>,
): boolean {
  const trimmed = keyOrPath.trim();
  if (trimmed.length === 0) {
    return false;
  }

  const lower = trimmed.toLowerCase();
  const normalized = normalizeKey(trimmed);
  if (extraSecretSet && (extraSecretSet.has(lower) || extraSecretSet.has(normalized))) {
    return true;
  }

  const segments = trimmed.split('.');
  for (const segment of segments) {
    if (
      extraSecretSet &&
      (extraSecretSet.has(segment.toLowerCase()) || extraSecretSet.has(normalizeKey(segment)))
    ) {
      return true;
    }
    const snakeSegment = segment.replace(/([a-z0-9])([A-Z])/g, '$1_$2');
    if (SECRET_KEY_PATTERN.test(segment) || SECRET_KEY_PATTERN.test(snakeSegment)) {
      return true;
    }
  }

  return false;
}

export function sanitizeConfigMessage(message: string): string {
  return message.replace(CREDENTIALED_URL_REGEX, `$1://$2:${REDACTED_PLACEHOLDER}@`);
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

function redactInternal(
  value: unknown,
  secretSet: ReadonlySet<string>,
  trail: string,
): unknown {
  if (isSecretValue(value)) {
    return REDACTED_PLACEHOLDER;
  }
  if (typeof value === 'string') {
    return sanitizeConfigMessage(value);
  }
  if (Array.isArray(value)) {
    return value.map((item, idx) => redactInternal(item, secretSet, `${trail}[${idx}]`));
  }
  if (isPlainRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      const nextTrail = trail ? `${trail}.${k}` : k;
      if (isSecretConfigKey(nextTrail, secretSet)) {
        out[k] = REDACTED_PLACEHOLDER;
      } else {
        out[k] = redactInternal(v, secretSet, nextTrail);
      }
    }
    return out;
  }
  return value;
}

/**
 * Returns a deep-cloned plain object representation of a validated config with all
 * secret keys, `SecretValue` wrappers, and embedded URL credentials replaced by `[REDACTED]`.
 */
export function redactConfig<TConfig extends Record<string, unknown>>(
  config: Readonly<TConfig>,
  options: RedactConfigOptions = {},
): Record<string, unknown> {
  const secretSet = buildSecretKeySet(options.secrets);
  return redactInternal(config, secretSet, '') as Record<string, unknown>;
}
