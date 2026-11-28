import {
  BadRequestError,
  PayloadTooLargeError,
  UnsupportedMediaTypeError,
} from './errors.js';
import type {
  BodyParseOptions,
  MultipartParseOptions,
  ParsedMultipart,
  UploadedFile,
} from './types.js';
import {
  sanitizeUploadFilename,
  validateUploadMagicBytesOrThrow,
  validateUploadMetadata,
} from './upload-validation.js';

export const DEFAULT_MAX_BODY_BYTES = 1_048_576; // 1 MiB
export const DEFAULT_MAX_MULTIPART_BYTES = 10 * 1_048_576; // 10 MiB
export const DEFAULT_MAX_MULTIPART_FIELDS = 100;
export const DEFAULT_MAX_MULTIPART_FILES = 10;
export const DEFAULT_MAX_MULTIPART_FILE_BYTES = 5 * 1_048_576; // 5 MiB

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const utf8Decoder = new TextDecoder('utf-8', { fatal: false });

export interface FastBoundedTextRequest {
  _readBoundedText?(maxBytes: number): Promise<string>;
}

function normalizeMaxBytes(maxBytes: number | undefined, fallback: number): number {
  const limit = maxBytes ?? fallback;
  if (!Number.isInteger(limit) || limit < 0) {
    throw new BadRequestError('Invalid maxBytes limit');
  }
  return limit;
}

export async function readBoundedBytes(
  request: Request,
  maxBytes: number = DEFAULT_MAX_BODY_BYTES,
): Promise<Uint8Array> {
  const limit = normalizeMaxBytes(maxBytes, DEFAULT_MAX_BODY_BYTES);

  const contentLengthHeader = request.headers.get('content-length');
  if (contentLengthHeader !== null) {
    const declaredLength = Number(contentLengthHeader);
    if (Number.isFinite(declaredLength) && declaredLength > limit) {
      if (request.body !== null) {
        try {
          await request.body.cancel();
        } catch {
          // Ignore cancellation errors on already-closed streams
        }
      }
      throw new PayloadTooLargeError(limit, `Request body exceeds limit of ${limit} bytes`);
    }
  }

  if (request.body === null) {
    return new Uint8Array(0);
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (!value) {
        continue;
      }

      totalBytes += value.byteLength;
      if (totalBytes > limit) {
        await reader.cancel('Payload too large');
        throw new PayloadTooLargeError(limit, `Request body exceeds limit of ${limit} bytes`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  if (chunks.length === 0) {
    return new Uint8Array(0);
  }
  if (chunks.length === 1) {
    return chunks[0] ?? new Uint8Array(0);
  }

  const merged = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}

export async function readBoundedText(
  request: Request,
  options: Pick<BodyParseOptions, 'maxBytes'> = {},
): Promise<string> {
  const limit = normalizeMaxBytes(options.maxBytes, DEFAULT_MAX_BODY_BYTES);

  const fastReq = request as unknown as FastBoundedTextRequest;
  if (typeof fastReq._readBoundedText === 'function') {
    const contentLengthHeader = request.headers.get('content-length');
    if (contentLengthHeader !== null) {
      const declaredLength = Number(contentLengthHeader);
      if (Number.isFinite(declaredLength) && declaredLength > limit) {
        if (request.body !== null) {
          try {
            await request.body.cancel();
          } catch {
            // Ignore cancellation errors
          }
        }
        throw new PayloadTooLargeError(limit, `Request body exceeds limit of ${limit} bytes`);
      }
    }
    return fastReq._readBoundedText(limit);
  }

  // Always read incrementally through readBoundedBytes so chunked Transfer-Encoding
  // bodies without Content-Length cancel immediately upon exceeding `limit` (SEC-01).
  const bytes = await readBoundedBytes(request, limit);
  return utf8Decoder.decode(bytes);
}

function isJsonContentType(contentType: string | null): boolean {
  if (!contentType) return false;
  if (
    contentType === 'application/json' ||
    contentType === 'application/json; charset=utf-8' ||
    contentType === 'application/json;charset=utf-8'
  ) {
    return true;
  }
  const mediaType = contentType.split(';', 1)[0]?.trim().toLowerCase() ?? '';
  return mediaType === 'application/json' || mediaType.endsWith('+json');
}

export function hasForbiddenKey(value: unknown): boolean {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      if (hasForbiddenKey(value[i])) return true;
    }
    return false;
  }
  const obj = value as Record<string, unknown>;
  if (
    Object.prototype.hasOwnProperty.call(obj, '__proto__') ||
    Object.prototype.hasOwnProperty.call(obj, 'constructor') ||
    Object.prototype.hasOwnProperty.call(obj, 'prototype')
  ) {
    return true;
  }
  for (const k in obj) {
    const v = obj[k];
    if (v !== null && typeof v === 'object' && hasForbiddenKey(v)) {
      return true;
    }
  }
  return false;
}

export function stripForbiddenKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      value[i] = stripForbiddenKeys(value[i]);
    }
    return value;
  }

  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const clean: Record<string, unknown> = {};
    for (const key of Object.keys(source)) {
      if (FORBIDDEN_KEYS.has(key)) {
        continue;
      }
      clean[key] = stripForbiddenKeys(source[key]);
    }
    return clean;
  }

  return value;
}

export async function readBoundedJson<T = unknown>(
  request: Request,
  options: BodyParseOptions = {},
): Promise<T> {
  const contentType = request.headers.get('content-type');
  if (contentType !== null && !isJsonContentType(contentType)) {
    throw new UnsupportedMediaTypeError(
      `Expected application/json content-type, received "${contentType}"`,
    );
  }

  const limit = normalizeMaxBytes(options.maxBytes, DEFAULT_MAX_BODY_BYTES);
  const contentLengthHeader = request.headers.get('content-length');
  let declaredLength = Number.NaN;
  if (contentLengthHeader !== null) {
    declaredLength = Number(contentLengthHeader);
    if (Number.isFinite(declaredLength) && declaredLength > limit) {
      if (request.body !== null) {
        try {
          await request.body.cancel();
        } catch {
          // Ignore cancellation errors on already-closed streams
        }
      }
      throw new PayloadTooLargeError(limit, `Request body exceeds limit of ${limit} bytes`);
    }
  }

  const fastReq = request as unknown as FastBoundedTextRequest;

  if (
    limit >= DEFAULT_MAX_BODY_BYTES &&
    typeof fastReq._readBoundedText !== 'function' &&
    Number.isFinite(declaredLength) &&
    declaredLength <= limit
  ) {
    let parsed: unknown;
    try {
      parsed = await request.json();
    } catch (err: unknown) {
      throw new BadRequestError('Malformed JSON request body', { cause: err });
    }
    if (options.allowProtoKeys === true || !hasForbiddenKey(parsed)) {
      return parsed as T;
    }
    return stripForbiddenKeys(parsed) as T;
  }

  const rawText = await readBoundedText(request, { maxBytes: limit });
  if (
    rawText.length === 0 ||
    (rawText.charCodeAt(0) <= 32 && rawText.trim().length === 0)
  ) {
    throw new BadRequestError('Request body is empty; expected valid JSON');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch (err: unknown) {
    throw new BadRequestError('Malformed JSON request body', { cause: err });
  }

  if (options.allowProtoKeys === true || !hasForbiddenKey(parsed)) {
    return parsed as T;
  }

  return stripForbiddenKeys(parsed) as T;
}

export async function readBoundedUrlEncoded(
  request: Request,
  options: Pick<BodyParseOptions, 'maxBytes'> = {},
): Promise<Readonly<Record<string, string | readonly string[]>>> {
  const contentType = request.headers.get('content-type');
  if (contentType !== null) {
    const mediaType = contentType.split(';', 1)[0]?.trim().toLowerCase() ?? '';
    if (mediaType !== 'application/x-www-form-urlencoded') {
      throw new UnsupportedMediaTypeError(
        `Expected application/x-www-form-urlencoded content-type, received "${contentType}"`,
      );
    }
  }

  const rawText = await readBoundedText(request, options);
  const params = new URLSearchParams(rawText);
  const record: Record<string, string | string[]> = Object.create(null) as Record<
    string,
    string | string[]
  >;

  for (const [key, value] of params.entries()) {
    if (FORBIDDEN_KEYS.has(key)) {
      continue;
    }
    const existing = record[key];
    if (existing === undefined) {
      record[key] = value;
    } else if (Array.isArray(existing)) {
      existing.push(value);
    } else {
      record[key] = [existing, value];
    }
  }

  return record;
}

export async function readBoundedMultipart(
  request: Request,
  options: MultipartParseOptions = {},
): Promise<ParsedMultipart> {
  const contentType = request.headers.get('content-type');
  const mediaType = contentType?.split(';', 1)[0]?.trim().toLowerCase() ?? '';
  if (mediaType !== 'multipart/form-data') {
    throw new UnsupportedMediaTypeError(
      `Expected multipart/form-data content-type, received "${contentType ?? 'none'}"`,
    );
  }

  const maxBytes = normalizeMaxBytes(options.maxBytes, DEFAULT_MAX_MULTIPART_BYTES);
  const maxFields = options.maxFields ?? DEFAULT_MAX_MULTIPART_FIELDS;
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_MULTIPART_FILES;
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_MULTIPART_FILE_BYTES;
  const shouldSanitizeNames = options.sanitizeFilenames !== false;

  const rawBytes = await readBoundedBytes(request, maxBytes);

  // Parse the bounded byte buffer through standard Web Response.formData()
  // so Node.js 22+ and Bun 1.4+ share identical RFC 7578 multipart parsing semantics.
  // Reuse the underlying ArrayBuffer directly when it is already an exact-fit buffer (SEC-02).
  let bodyBuffer: Uint8Array<ArrayBuffer>;
  if (
    rawBytes.buffer instanceof ArrayBuffer &&
    rawBytes.byteOffset === 0 &&
    rawBytes.byteLength === rawBytes.buffer.byteLength
  ) {
    bodyBuffer = rawBytes as Uint8Array<ArrayBuffer>;
  } else {
    bodyBuffer = new Uint8Array(rawBytes.byteLength);
    bodyBuffer.set(rawBytes);
  }

  let formData: FormData;
  try {
    const synthetic = new Response(bodyBuffer, {
      headers: { 'content-type': contentType ?? 'multipart/form-data' },
    });
    formData = await synthetic.formData();
  } catch (err: unknown) {
    throw new BadRequestError('Malformed multipart/form-data payload', { cause: err });
  }

  const fields: Record<string, string | string[]> = Object.create(null) as Record<
    string,
    string | string[]
  >;
  const files: UploadedFile[] = [];
  let fieldCount = 0;

  for (const [fieldName, entry] of formData.entries()) {
    if (typeof entry === 'string') {
      if (FORBIDDEN_KEYS.has(fieldName)) {
        continue;
      }
      fieldCount += 1;
      if (fieldCount > maxFields) {
        throw new BadRequestError(`Multipart field count exceeds limit of ${maxFields}`);
      }
      const existing = fields[fieldName];
      if (existing === undefined) {
        fields[fieldName] = entry;
      } else if (Array.isArray(existing)) {
        existing.push(entry);
      } else {
        fields[fieldName] = [existing, entry];
      }
    } else {
      if (files.length >= maxFiles) {
        throw new BadRequestError(`Multipart file count exceeds limit of ${maxFiles}`);
      }
      const rawName = 'name' in entry && typeof entry.name === 'string' ? entry.name : 'upload';
      const safeName = shouldSanitizeNames ? sanitizeUploadFilename(rawName) : rawName;

      if (entry.size > maxFileBytes) {
        throw new PayloadTooLargeError(
          maxFileBytes,
          `Uploaded file "${safeName}" exceeds limit of ${maxFileBytes} bytes`,
        );
      }

      const blob: Blob = entry;
      const mimeType = blob.type || 'application/octet-stream';
      validateUploadMetadata(safeName, mimeType, options);

      if (options.verifyMagicBytes === true) {
        const headerSlice = new Uint8Array(await blob.slice(0, 16).arrayBuffer());
        validateUploadMagicBytesOrThrow(safeName, mimeType, headerSlice, options);
      }

      files.push({
        fieldName,
        name: safeName,
        rawName,
        type: mimeType,
        size: blob.size,
        blob,
        arrayBuffer: () => blob.arrayBuffer(),
        text: () => blob.text(),
      });
    }
  }

  return { fields, files };
}
