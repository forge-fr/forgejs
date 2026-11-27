import { isSecretValue } from '@forge-fr/core';
import { StorageObjectNotFoundError, StorageValidationError } from './errors.js';
import type {
  MemoryStorageOptions,
  StorageAdapter,
  StorageListOptions,
  StorageListResult,
  StorageObject,
  StorageObjectMetadata,
  StoragePutOptions,
  StorageSignedUrlOptions,
  StorageUploadData,
} from './types.js';
import {
  canonicalizeStorageKey,
  computeSha256Hex,
  createStorageObject,
  toArrayBufferCopy,
  validateObjectUpload,
} from './validation.js';

interface MemoryRecord {
  readonly metadata: StorageObjectMetadata;
  readonly bytes: Uint8Array;
}

export function createMemoryStorageAdapter(options: MemoryStorageOptions = {}): StorageAdapter {
  const records = new Map<string, MemoryRecord>();
  const signingSecretRaw = isSecretValue(options.signingKey)
    ? options.signingKey.reveal()
    : (options.signingKey ?? 'forge-memory-ephemeral-signing-key');
  let connected = false;

  async function hmacSign(payload: string): Promise<string> {
    const keyBytes = new TextEncoder().encode(signingSecretRaw);
    const cryptoKey = await globalThis.crypto.subtle.importKey(
      'raw',
      toArrayBufferCopy(keyBytes),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    const sig = await globalThis.crypto.subtle.sign(
      'HMAC',
      cryptoKey,
      toArrayBufferCopy(new TextEncoder().encode(payload)),
    );
    return Array.from(new Uint8Array(sig), (b) => b.toString(16).padStart(2, '0')).join('');
  }

  return {
    driver: 'memory',

    async connect(): Promise<void> {
      connected = true;
    },

    async disconnect(): Promise<void> {
      connected = false;
    },

    async ping(): Promise<boolean> {
      return connected;
    },

    async put(
      key: string,
      data: StorageUploadData,
      putOptions?: StoragePutOptions,
    ): Promise<StorageObjectMetadata> {
      const validated = await validateObjectUpload(key, data, putOptions, options);
      const etag = await computeSha256Hex(validated.bytes);
      const metadata: StorageObjectMetadata = {
        key: validated.key,
        size: validated.bytes.byteLength,
        etag,
        contentType: validated.contentType,
        lastModified: new Date(),
        ...(validated.metadata !== undefined ? { metadata: validated.metadata } : {}),
      };
      records.set(validated.key, { metadata, bytes: validated.bytes });
      return metadata;
    },

    async get(key: string): Promise<StorageObject> {
      const canonical = canonicalizeStorageKey(key);
      const record = records.get(canonical);
      if (!record) {
        throw new StorageObjectNotFoundError(canonical);
      }
      return createStorageObject(record.metadata, record.bytes);
    },

    async head(key: string): Promise<StorageObjectMetadata | undefined> {
      const canonical = canonicalizeStorageKey(key);
      return records.get(canonical)?.metadata;
    },

    async exists(key: string): Promise<boolean> {
      const canonical = canonicalizeStorageKey(key);
      return records.has(canonical);
    },

    async delete(key: string): Promise<boolean> {
      const canonical = canonicalizeStorageKey(key);
      return records.delete(canonical);
    },

    async list(listOptions: StorageListOptions = {}): Promise<StorageListResult> {
      const prefix = listOptions.prefix ?? '';
      const limit = listOptions.limit ?? 1000;
      const offset = listOptions.cursor ? Number.parseInt(listOptions.cursor, 10) : 0;

      const sorted = Array.from(records.values())
        .filter((r) => prefix.length === 0 || r.metadata.key.startsWith(prefix))
        .sort((a, b) => a.metadata.key.localeCompare(b.metadata.key));

      const slice = sorted.slice(offset, offset + limit).map((r) => r.metadata);
      const nextOffset = offset + slice.length;
      const nextCursor = nextOffset < sorted.length ? String(nextOffset) : undefined;

      return {
        objects: slice,
        ...(nextCursor !== undefined ? { nextCursor } : {}),
      };
    },

    async getSignedUrl(
      key: string,
      signedOptions: StorageSignedUrlOptions = {},
    ): Promise<string> {
      const canonical = canonicalizeStorageKey(key);
      const expiresIn = signedOptions.expiresInSeconds ?? 300;
      if (!Number.isFinite(expiresIn) || expiresIn <= 0) {
        throw new StorageValidationError('expiresInSeconds must be a positive number');
      }
      const method = signedOptions.method ?? 'GET';
      const expiresAt = Math.floor(Date.now() / 1000) + Math.trunc(expiresIn);
      const canonicalQuery = `${method}:${canonical}:${expiresAt}`;
      const signature = await hmacSign(canonicalQuery);
      return `forge-memory://objects/${encodeURIComponent(canonical)}?method=${method}&expires=${expiresAt}&signature=${signature}`;
    },
  };
}
