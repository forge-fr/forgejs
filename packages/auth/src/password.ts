import type { Algorithm } from '@node-rs/argon2';
import { ConfigurationError, ValidationError } from '@forge-fr/core';

export interface PasswordHasher {
  hash(password: string): Promise<string>;
  verify(password: string, encodedHash: string): Promise<boolean>;
  needsRehash(encodedHash: string): boolean;
}

export interface WebCryptoPasswordHasherOptions {
  /** PBKDF2-SHA256 iteration count (default: 100_000; minimum: 1_000). */
  readonly iterations?: number;
  /** Maximum UTF-8 password byte length accepted to prevent hashing DoS (default: 1024). */
  readonly maxPasswordBytes?: number;
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
  /**
   * Runtime backend selection (default: `'auto'` uses native Bun password API on Bun,
   * lazy-loaded `@node-rs/argon2` on Node.js, and Web Crypto PBKDF2-SHA256 fallback on Edge).
   */
  readonly backend?: 'auto' | 'node-rs' | 'bun' | 'webcrypto';
  /** Iteration count used if Web Crypto PBKDF2-SHA256 backend or Edge fallback is selected (default: 100_000). */
  readonly webCryptoIterations?: number;
}

interface BunPasswordApi {
  hash(
    password: string,
    options: { readonly algorithm: 'argon2id'; readonly memoryCost: number; readonly timeCost: number },
  ): Promise<string>;
  verify(password: string, hash: string): Promise<boolean>;
}

interface NodeRsArgon2Module {
  hash(
    password: string,
    options: {
      readonly algorithm: Algorithm;
      readonly memoryCost: number;
      readonly timeCost: number;
      readonly parallelism: number;
      readonly outputLen: number;
    },
  ): Promise<string>;
  verify(encodedHash: string, password: string): Promise<boolean>;
}

const MIN_MEMORY_COST_KIB = 12288;
const DEFAULT_MEMORY_COST_KIB = 19456;
const MIN_TIME_COST = 2;
const DEFAULT_TIME_COST = 2;
const DEFAULT_PARALLELISM = 1;
const DEFAULT_OUTPUT_LEN = 32;
const DEFAULT_MAX_PASSWORD_BYTES = 1024;

const PBKDF2_PREFIX = '$pbkdf2-sha256$';
const MIN_PBKDF2_ITERATIONS = 1_000;
const DEFAULT_PBKDF2_ITERATIONS = 100_000;
const PBKDF2_SALT_BYTES = 16;
const PBKDF2_DERIVED_BITS = 256;

const TEXT_ENCODER = new TextEncoder();

let cachedNodeRsArgon2Promise: Promise<NodeRsArgon2Module | null> | null = null;

function loadNodeRsArgon2(): Promise<NodeRsArgon2Module | null> {
  if (cachedNodeRsArgon2Promise === null) {
    const specifier = '@node-rs/' + 'argon2';
    cachedNodeRsArgon2Promise = import(/* @vite-ignore */ specifier)
      .then((mod: unknown) => {
        if (
          typeof mod === 'object' &&
          mod !== null &&
          'hash' in mod &&
          typeof (mod as { hash?: unknown }).hash === 'function' &&
          'verify' in mod &&
          typeof (mod as { verify?: unknown }).verify === 'function'
        ) {
          return mod as NodeRsArgon2Module;
        }
        return null;
      })
      .catch(() => null);
  }
  return cachedNodeRsArgon2Promise;
}

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

function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) {
    out += byte.toString(16).padStart(2, '0');
  }
  return out;
}

function fromHex(hex: string): Uint8Array | null {
  if (hex.length === 0 || hex.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(hex)) {
    return null;
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function constantTimeBytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  }
  return diff === 0;
}

async function derivePbkdf2Sha256(
  password: string,
  salt: Uint8Array,
  iterations: number,
): Promise<Uint8Array> {
  const keyMaterial = await globalThis.crypto.subtle.importKey(
    'raw',
    TEXT_ENCODER.encode(password),
    'PBKDF2',
    false,
    ['deriveBits'],
  );

  const saltCopy = new Uint8Array(salt);
  const derived = await globalThis.crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      hash: 'SHA-256',
      salt: saltCopy,
      iterations,
    },
    keyMaterial,
    PBKDF2_DERIVED_BITS,
  );

  return new Uint8Array(derived);
}

/**
 * Pure WinterCG Web Crypto (`crypto.subtle`) PBKDF2-SHA256 password hasher for
 * Cloudflare Workers, Deno Deploy, and Edge isolates where native C++ addons
 * (`@node-rs/argon2`) are unavailable.
 */
export function createWebCryptoPasswordHasher(
  options: WebCryptoPasswordHasherOptions = {},
): PasswordHasher {
  const iterations = options.iterations ?? DEFAULT_PBKDF2_ITERATIONS;
  const maxPasswordBytes = options.maxPasswordBytes ?? DEFAULT_MAX_PASSWORD_BYTES;

  if (!Number.isInteger(iterations) || iterations < MIN_PBKDF2_ITERATIONS) {
    throw new ConfigurationError(
      `WebCrypto PBKDF2-SHA256 iterations must be an integer >= ${MIN_PBKDF2_ITERATIONS}`,
    );
  }
  if (!Number.isInteger(maxPasswordBytes) || maxPasswordBytes < 16) {
    throw new ConfigurationError('maxPasswordBytes must be an integer >= 16');
  }

  return {
    async hash(password: string): Promise<string> {
      if (typeof password !== 'string' || password.length === 0) {
        throw new ValidationError('Password must be a non-empty string');
      }
      if (TEXT_ENCODER.encode(password).byteLength > maxPasswordBytes) {
        throw new ValidationError(
          `Password exceeds maximum allowed length of ${maxPasswordBytes} bytes`,
        );
      }

      const salt = new Uint8Array(PBKDF2_SALT_BYTES);
      globalThis.crypto.getRandomValues(salt);
      const digest = await derivePbkdf2Sha256(password, salt, iterations);
      return `${PBKDF2_PREFIX}i=${iterations}$${toHex(salt)}$${toHex(digest)}`;
    },

    async verify(password: string, encodedHash: string): Promise<boolean> {
      if (
        typeof password !== 'string' ||
        password.length === 0 ||
        typeof encodedHash !== 'string' ||
        !encodedHash.startsWith(PBKDF2_PREFIX)
      ) {
        return false;
      }
      if (TEXT_ENCODER.encode(password).byteLength > maxPasswordBytes) {
        return false;
      }

      const match = /^\$pbkdf2-sha256\$i=(\d+)\$([0-9a-f]+)\$([0-9a-f]+)$/i.exec(encodedHash);
      if (!match) {
        return false;
      }

      const parsedIterations = Number(match[1]);
      const salt = fromHex(match[2] ?? '');
      const expectedDigest = fromHex(match[3] ?? '');
      if (
        !Number.isInteger(parsedIterations) ||
        parsedIterations < 1 ||
        salt === null ||
        expectedDigest === null
      ) {
        return false;
      }

      try {
        const candidate = await derivePbkdf2Sha256(password, salt, parsedIterations);
        return constantTimeBytesEqual(candidate, expectedDigest);
      } catch {
        return false;
      }
    },

    needsRehash(encodedHash: string): boolean {
      const match = /^\$pbkdf2-sha256\$i=(\d+)\$/i.exec(encodedHash);
      if (!match) {
        return true;
      }
      return Number(match[1]) < iterations;
    },
  };
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
  const webCryptoIterations = options.webCryptoIterations ?? DEFAULT_PBKDF2_ITERATIONS;

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

  const webCryptoHasher = createWebCryptoPasswordHasher({
    iterations: webCryptoIterations,
    maxPasswordBytes,
  });

  if (backend === 'webcrypto') {
    return webCryptoHasher;
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

      const argon2 = await loadNodeRsArgon2();
      if (argon2 !== null) {
        return argon2.hash(password, {
          algorithm: 2 as Algorithm,
          memoryCost,
          timeCost,
          parallelism,
          outputLen,
        });
      }

      if (backend === 'node-rs') {
        throw new ConfigurationError(
          'Requested @node-rs/argon2 password backend is unavailable in this runtime',
        );
      }

      return webCryptoHasher.hash(password);
    },

    async verify(password: string, encodedHash: string): Promise<boolean> {
      if (typeof password !== 'string' || password.length === 0 || typeof encodedHash !== 'string') {
        return false;
      }
      if (TEXT_ENCODER.encode(password).byteLength > maxPasswordBytes) {
        return false;
      }

      if (encodedHash.startsWith(PBKDF2_PREFIX)) {
        return webCryptoHasher.verify(password, encodedHash);
      }

      if (!encodedHash.startsWith('$argon2')) {
        return false;
      }

      try {
        if (useBunNative && bunApi !== null) {
          return await bunApi.verify(password, encodedHash);
        }
        const argon2 = await loadNodeRsArgon2();
        if (argon2 !== null) {
          return await argon2.verify(encodedHash, password);
        }
        return false;
      } catch {
        return false;
      }
    },

    needsRehash(encodedHash: string): boolean {
      if (encodedHash.startsWith(PBKDF2_PREFIX)) {
        return true;
      }
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
