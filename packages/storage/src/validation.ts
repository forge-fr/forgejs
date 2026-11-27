import { StoragePathError, StorageValidationError } from './errors.js';
import type {
  StorageObject,
  StorageObjectMetadata,
  StoragePutOptions,
  StorageUploadData,
  StorageValidationConfig,
} from './types.js';

const MAX_KEY_LENGTH = 1024;
const CONTROL_CHARS_RE = /[\x00-\x1f\x7f]/;
const WINDOWS_RESERVED_RE = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\..*)?$/i;
const FORBIDDEN_METADATA_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function assertSafeSegment(segment: string): void {
  if (segment.length === 0 || segment === '.' || segment === '..') {
    throw new StoragePathError(`Invalid storage key segment "${segment}"`);
  }
  if (segment.includes('\\') || segment.includes(':')) {
    throw new StoragePathError('Storage key contains disallowed path separator or drive delimiter');
  }
  if (WINDOWS_RESERVED_RE.test(segment)) {
    throw new StoragePathError(`Storage key uses reserved device name "${segment}"`);
  }
}

/**
 * Validates and normalizes an object storage key, rejecting traversal segments,
 * URL-encoded dot segments, backslashes, drive prefixes, control characters, and reserved names.
 */
export function canonicalizeStorageKey(rawKey: string): string {
  if (typeof rawKey !== 'string' || rawKey.trim().length === 0 || rawKey.length > MAX_KEY_LENGTH) {
    throw new StoragePathError('Storage key must be a non-empty string within 1024 characters');
  }
  if (CONTROL_CHARS_RE.test(rawKey)) {
    throw new StoragePathError('Storage key contains disallowed control or NUL characters');
  }
  if (rawKey.startsWith('/') || rawKey.startsWith('\\') || rawKey.includes('\\')) {
    throw new StoragePathError('Storage key must be relative and use forward slashes');
  }
  if (/^[A-Za-z]:/.test(rawKey)) {
    throw new StoragePathError('Storage key must not include a Windows drive prefix');
  }

  // Decode up to 2 passes to catch double-encoded traversal sequences such as %252e%252e
  let decoded = rawKey;
  for (let pass = 0; pass < 2; pass += 1) {
    if (!decoded.includes('%')) {
      break;
    }
    try {
      const next = decodeURIComponent(decoded);
      if (next === decoded) {
        break;
      }
      decoded = next;
    } catch {
      throw new StoragePathError('Storage key contains malformed percent-encoding');
    }
    if (decoded.includes('\\') || CONTROL_CHARS_RE.test(decoded) || /^[A-Za-z]:/.test(decoded)) {
      throw new StoragePathError('Storage key decodes to unsafe path characters');
    }
  }

  const rawSegments = rawKey.split('/');
  const decodedSegments = decoded.split('/');

  for (const seg of rawSegments) {
    assertSafeSegment(seg);
  }
  for (const seg of decodedSegments) {
    assertSafeSegment(seg);
  }

  return rawSegments.join('/');
}

export async function toUint8Array(data: StorageUploadData): Promise<Uint8Array> {
  if (data instanceof Uint8Array) {
    return new Uint8Array(data);
  }
  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data.slice(0));
  }
  if (typeof data === 'string') {
    return new TextEncoder().encode(data);
  }
  if (typeof ReadableStream !== 'undefined' && data instanceof ReadableStream) {
    const reader = data.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      if (value) {
        chunks.push(value);
        total += value.byteLength;
      }
    }
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return merged;
  }
  throw new StorageValidationError('Unsupported upload body type');
}

export function toArrayBufferCopy(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

export async function computeSha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', toArrayBufferCopy(bytes));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

function startsWithBytes(bytes: Uint8Array, prefix: readonly number[]): boolean {
  if (bytes.byteLength < prefix.length) {
    return false;
  }
  for (let i = 0; i < prefix.length; i += 1) {
    if (bytes[i] !== prefix[i]) {
      return false;
    }
  }
  return true;
}

function matchesAscii(bytes: Uint8Array, offset: number, ascii: string): boolean {
  if (bytes.byteLength < offset + ascii.length) {
    return false;
  }
  for (let i = 0; i < ascii.length; i += 1) {
    if (bytes[offset + i] !== ascii.charCodeAt(i)) {
      return false;
    }
  }
  return true;
}

export function verifyMagicBytesForMime(bytes: Uint8Array, contentType: string): boolean {
  switch (contentType) {
    case 'image/png':
      return startsWithBytes(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    case 'image/jpeg':
      return startsWithBytes(bytes, [0xff, 0xd8, 0xff]);
    case 'image/gif':
      return matchesAscii(bytes, 0, 'GIF87a') || matchesAscii(bytes, 0, 'GIF89a');
    case 'image/webp':
      return matchesAscii(bytes, 0, 'RIFF') && matchesAscii(bytes, 8, 'WEBP');
    case 'application/pdf':
      return matchesAscii(bytes, 0, '%PDF-');
    case 'application/zip':
      return (
        startsWithBytes(bytes, [0x50, 0x4b, 0x03, 0x04]) ||
        startsWithBytes(bytes, [0x50, 0x4b, 0x05, 0x06])
      );
    case 'application/json': {
      const text = new TextDecoder().decode(bytes).trimStart();
      if (text.length === 0 || text.startsWith('<')) {
        return false;
      }
      return (
        text.startsWith('{') ||
        text.startsWith('[') ||
        text.startsWith('"') ||
        text.startsWith('true') ||
        text.startsWith('false') ||
        text.startsWith('null') ||
        /^-?\d/.test(text)
      );
    }
    default: {
      // Block executable HTML/SVG markup masquerading under generic binary MIME types
      const snippet = new TextDecoder().decode(bytes.subarray(0, 128)).trimStart().toLowerCase();
      if (
        !contentType.startsWith('text/') &&
        contentType !== 'image/svg+xml' &&
        (snippet.startsWith('<!doctype') || snippet.startsWith('<html') || snippet.startsWith('<script'))
      ) {
        return false;
      }
      return true;
    }
  }
}

export function sanitizeUserMetadata(
  raw: Readonly<Record<string, string>> | undefined,
): Readonly<Record<string, string>> | undefined {
  if (!raw) {
    return undefined;
  }
  const clean: Record<string, string> = {};
  for (const key of Object.keys(raw)) {
    if (FORBIDDEN_METADATA_KEYS.has(key) || key.trim().length === 0) {
      continue;
    }
    const val = raw[key];
    if (typeof val === 'string') {
      Object.defineProperty(clean, key, {
        value: val,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
  }
  return Object.keys(clean).length > 0 ? clean : undefined;
}

export interface ValidatedUpload {
  readonly key: string;
  readonly bytes: Uint8Array;
  readonly contentType: string;
  readonly metadata?: Readonly<Record<string, string>>;
}

export async function validateObjectUpload(
  key: string,
  data: StorageUploadData,
  putOptions: StoragePutOptions | undefined,
  config: StorageValidationConfig,
): Promise<ValidatedUpload> {
  const canonicalKey = canonicalizeStorageKey(key);
  const bytes = await toUint8Array(data);

  if (config.maxObjectBytes !== undefined && bytes.byteLength > config.maxObjectBytes) {
    throw new StorageValidationError(
      `Object "${canonicalKey}" (${bytes.byteLength} bytes) exceeds maxObjectBytes (${config.maxObjectBytes})`,
      { key: canonicalKey, size: bytes.byteLength, maxObjectBytes: config.maxObjectBytes },
    );
  }

  const rawType = putOptions?.contentType ?? 'application/octet-stream';
  const contentType = rawType.split(';')[0]!.trim().toLowerCase();

  if (config.allowedMimeTypes !== undefined) {
    const allowed = new Set(config.allowedMimeTypes.map((m) => m.trim().toLowerCase()));
    if (!allowed.has(contentType)) {
      throw new StorageValidationError(
        `Content type "${contentType}" is not permitted by storage allowlist`,
        { key: canonicalKey, contentType },
      );
    }
  }

  if (config.verifyMagicBytes === true && !verifyMagicBytesForMime(bytes, contentType)) {
    throw new StorageValidationError(
      `Uploaded binary signature does not match declared contentType "${contentType}"`,
      { key: canonicalKey, contentType },
    );
  }

  const metadata = sanitizeUserMetadata(putOptions?.metadata);
  return {
    key: canonicalKey,
    bytes,
    contentType,
    ...(metadata !== undefined ? { metadata } : {}),
  };
}

export function createStorageObject(
  metadata: StorageObjectMetadata,
  bytes: Uint8Array,
): StorageObject {
  return {
    metadata,
    async arrayBuffer(): Promise<ArrayBuffer> {
      return toArrayBufferCopy(bytes);
    },
    async bytes(): Promise<Uint8Array> {
      return new Uint8Array(bytes);
    },
    async text(): Promise<string> {
      return new TextDecoder().decode(bytes);
    },
    stream(): ReadableStream<Uint8Array> {
      const snapshot = new Uint8Array(bytes);
      return new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(snapshot);
          controller.close();
        },
      });
    },
  };
}
