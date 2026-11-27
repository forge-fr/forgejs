import { hash as argon2Hash, verify as argon2Verify, type Algorithm } from '@node-rs/argon2';
import { ConfigurationError, ValidationError } from '@forge-fr/core';

export interface PasswordHasher {
  hash(password: string): Promise<string>;
  verify(password: string, encodedHash: string): Promise<boolean>;
  needsRehash(encodedHash: string): boolean;
}

export interface Argon2PasswordHasherOptions {
  /** Memory cost in KiB. OWASP ASVS 5.0.0 floor: >= 12288 (default: 19456 = 19 MiB). */
  readonly memoryCost?: number;
  /** Iteration count. OWASP floor: >= 2 (default: 2). */
  readonly timeCost?: number;
  /** Parallelism degree (default: 1). */
  readonly parallelism?: number;
  /** Hash output length in bytes (default: 32). */
  readonly outputLen?: number;
  /** Maximum UTF-8 password byte length accepted to prevent hashing DoS (default: 1024). */
  readonly maxPasswordBytes?: number;
  /** Runtime backend selection (default: 'auto' uses native Bun password API on Bun and @node-rs/argon2 on Node). */
  readonly backend?: 'auto' | 'node-rs' | 'bun';
}

interface BunPasswordApi {
  hash(
    password: string,
    options: { readonly algorithm: 'argon2id'; readonly memoryCost: number; readonly timeCost: number },
  ): Promise<string>;
  verify(password: string, hash: string): Promise<boolean>;
}

const MIN_MEMORY_COST_KIB = 12288;
const DEFAULT_MEMORY_COST_KIB = 19456;
const MIN_TIME_COST = 2;
const DEFAULT_TIME_COST = 2;
const DEFAULT_PARALLELISM = 1;
const DEFAULT_OUTPUT_LEN = 32;
const DEFAULT_MAX_PASSWORD_BYTES = 1024;
const TEXT_ENCODER = new TextEncoder();

function getBunPasswordApi(): BunPasswordApi | null {
  const bunRuntime = Reflect.get(globalThis, 'Bun') as
    | { readonly password?: Partial<BunPasswordApi> }
    | undefined;
  const api = bunRuntime?.password;
  if (api && typeof api.hash === 'function' && typeof api.verify === 'function') {
    return api as BunPasswordApi;
  }
  return null;
}

function parseArgon2PhcParams(
  encodedHash: string,
): { readonly memoryCost: number; readonly timeCost: number; readonly parallelism: number } | null {
  if (!encodedHash.startsWith('$argon2id$')) {
    return null;
  }
  const match = /^\$argon2id\$v=\d+\$m=(\d+),t=(\d+),p=(\d+)\$/.exec(encodedHash);
  if (!match) {
    return null;
  }
  const m = Number(match[1]);
  const t = Number(match[2]);
  const p = Number(match[3]);
  if (!Number.isFinite(m) || !Number.isFinite(t) || !Number.isFinite(p)) {
    return null;
  }
  return { memoryCost: m, timeCost: t, parallelism: p };
}

export function createArgon2PasswordHasher(
  options: Argon2PasswordHasherOptions = {},
): PasswordHasher {
  const memoryCost = options.memoryCost ?? DEFAULT_MEMORY_COST_KIB;
  const timeCost = options.timeCost ?? DEFAULT_TIME_COST;
  const parallelism = options.parallelism ?? DEFAULT_PARALLELISM;
  const outputLen = options.outputLen ?? DEFAULT_OUTPUT_LEN;
  const maxPasswordBytes = options.maxPasswordBytes ?? DEFAULT_MAX_PASSWORD_BYTES;
  const backend = options.backend ?? 'auto';

  if (!Number.isInteger(memoryCost) || memoryCost < MIN_MEMORY_COST_KIB) {
    throw new ConfigurationError(
      `Argon2id memoryCost must be an integer >= ${MIN_MEMORY_COST_KIB} KiB`,
    );
  }
  if (!Number.isInteger(timeCost) || timeCost < MIN_TIME_COST) {
    throw new ConfigurationError(`Argon2id timeCost must be an integer >= ${MIN_TIME_COST}`);
  }
  if (!Number.isInteger(parallelism) || parallelism < 1) {
    throw new ConfigurationError('Argon2id parallelism must be an integer >= 1');
  }
  if (!Number.isInteger(outputLen) || outputLen < 16 || outputLen > 128) {
    throw new ConfigurationError('Argon2id outputLen must be an integer between 16 and 128');
  }
  if (!Number.isInteger(maxPasswordBytes) || maxPasswordBytes < 16) {
    throw new ConfigurationError('maxPasswordBytes must be an integer >= 16');
  }

  const bunApi = backend === 'node-rs' ? null : getBunPasswordApi();
  if (backend === 'bun' && bunApi === null) {
    throw new ConfigurationError('Requested Bun Argon2id password backend outside of Bun runtime');
  }

  // Native Bun password API defaults to p=1, outputLen=32; delegate custom p/outputLen to @node-rs/argon2 for exact compliance
  const useBunNative =
    bunApi !== null && parallelism === 1 && outputLen === 32 && (backend === 'auto' || backend === 'bun');

  return {
    async hash(password: string): Promise<string> {
      if (typeof password !== 'string' || password.length === 0) {
        throw new ValidationError('Password must be a non-empty string');
      }
      if (TEXT_ENCODER.encode(password).byteLength > maxPasswordBytes) {
        throw new ValidationError(`Password exceeds maximum allowed length of ${maxPasswordBytes} bytes`);
      }

      if (useBunNative && bunApi !== null) {
        return bunApi.hash(password, {
          algorithm: 'argon2id',
          memoryCost,
          timeCost,
        });
      }

      return argon2Hash(password, {
        algorithm: 2 as Algorithm,
        memoryCost,
        timeCost,
        parallelism,
        outputLen,
      });
    },

    async verify(password: string, encodedHash: string): Promise<boolean> {
      if (
        typeof password !== 'string' ||
        password.length === 0 ||
        typeof encodedHash !== 'string' ||
        !encodedHash.startsWith('$argon2')
      ) {
        return false;
      }
      if (TEXT_ENCODER.encode(password).byteLength > maxPasswordBytes) {
        return false;
      }

      try {
        if (useBunNative && bunApi !== null) {
          return await bunApi.verify(password, encodedHash);
        }
        return await argon2Verify(encodedHash, password);
      } catch {
        return false;
      }
    },

    needsRehash(encodedHash: string): boolean {
      const parsed = parseArgon2PhcParams(encodedHash);
      if (parsed === null) {
        return true;
      }
      return (
        parsed.memoryCost < memoryCost ||
        parsed.timeCost < timeCost ||
        parsed.parallelism < parallelism
      );
    },
  };
}
