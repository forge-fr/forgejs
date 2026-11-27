import { ValidationError } from '@forge-fr/core';
import type { PasswordHasher } from '@forge-fr/auth';

const PREFIX = '$pbkdf2-sha256$';
const DEFAULT_ITERATIONS = 10_000;
const SALT_BYTES = 16;
const DERIVED_BITS = 256;
const MAX_PASSWORD_BYTES = 1024;
const ENCODER = new TextEncoder();

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

function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  }
  return diff === 0;
}

async function derivePbkdf2(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    ENCODER.encode(password),
    'PBKDF2',
    false,
    ['deriveBits'],
  );

  const saltCopy = new Uint8Array(salt);
  const derived = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      hash: 'SHA-256',
      salt: saltCopy,
      iterations,
    },
    keyMaterial,
    DERIVED_BITS,
  );

  return new Uint8Array(derived);
}

/**
 * Pure Web Crypto PBKDF2-SHA256 PasswordHasher for Cloudflare Workers / WinterCG Edge
 * where native C++ addons (@node-rs/argon2) are unavailable.
 */
export function createWebCryptoPasswordHasher(iterations = DEFAULT_ITERATIONS): PasswordHasher {
  return {
    async hash(password: string): Promise<string> {
      if (typeof password !== 'string' || password.length === 0) {
        throw new ValidationError('Password must be a non-empty string');
      }
      if (ENCODER.encode(password).byteLength > MAX_PASSWORD_BYTES) {
        throw new ValidationError(`Password exceeds maximum allowed length of ${MAX_PASSWORD_BYTES} bytes`);
      }

      const salt = new Uint8Array(SALT_BYTES);
      crypto.getRandomValues(salt);
      const digest = await derivePbkdf2(password, salt, iterations);
      return `${PREFIX}i=${iterations}$${toHex(salt)}$${toHex(digest)}`;
    },

    async verify(password: string, encodedHash: string): Promise<boolean> {
      if (
        typeof password !== 'string' ||
        password.length === 0 ||
        typeof encodedHash !== 'string' ||
        !encodedHash.startsWith(PREFIX)
      ) {
        return false;
      }
      if (ENCODER.encode(password).byteLength > MAX_PASSWORD_BYTES) {
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
        const candidate = await derivePbkdf2(password, salt, parsedIterations);
        return constantTimeEqual(candidate, expectedDigest);
      } catch {
        return false;
      }
    },

    needsRehash(encodedHash: string): boolean {
      const match = /^\$pbkdf2-sha256\$i=(\d+)\$/i.exec(encodedHash);
      if (!match) return true;
      return Number(match[1]) < iterations;
    },
  };
}
