import { UnsupportedMediaTypeError } from './errors.js';

const CONTROL_CHARS_RE = /[\x00-\x1f\x7f]/g;
const WINDOWS_RESERVED_RE = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\..*)?$/i;
const MAX_FILENAME_LENGTH = 255;

/**
 * Sanitizes an uploaded filename to prevent path traversal, header injection,
 * NUL/control bytes, and Windows reserved device names while preserving safe names.
 */
export function sanitizeUploadFilename(rawName: string, fallback = 'upload'): string {
  if (typeof rawName !== 'string') {
    return fallback;
  }

  // Strip directory components across both POSIX and Windows separators
  let cleaned = rawName.replace(CONTROL_CHARS_RE, '').trim();
  const lastSlash = Math.max(cleaned.lastIndexOf('/'), cleaned.lastIndexOf('\\'));
  if (lastSlash !== -1) {
    cleaned = cleaned.slice(lastSlash + 1);
  }

  // Remove any remaining traversal markers, colons, quotes, or wildcard characters
  cleaned = cleaned.replace(/[<>:"|?*]/g, '_').replace(/^\.+/, '');
  cleaned = cleaned.trim();

  if (cleaned.length === 0 || cleaned === '.' || cleaned === '..') {
    return fallback;
  }

  if (WINDOWS_RESERVED_RE.test(cleaned)) {
    cleaned = `_${cleaned}`;
  }

  if (cleaned.length > MAX_FILENAME_LENGTH) {
    const dotIdx = cleaned.lastIndexOf('.');
    if (dotIdx > 0 && cleaned.length - dotIdx <= 16) {
      const ext = cleaned.slice(dotIdx);
      cleaned = `${cleaned.slice(0, MAX_FILENAME_LENGTH - ext.length)}${ext}`;
    } else {
      cleaned = cleaned.slice(0, MAX_FILENAME_LENGTH);
    }
  }

  return cleaned || fallback;
}

function extractExtension(filename: string): string {
  const base = sanitizeUploadFilename(filename, '');
  const dotIdx = base.lastIndexOf('.');
  if (dotIdx <= 0 || dotIdx === base.length - 1) {
    return '';
  }
  return base.slice(dotIdx).toLowerCase();
}

function normalizeMime(mime: string): string {
  return mime.split(';', 1)[0]?.trim().toLowerCase() ?? '';
}

function matchesMimeAllowlist(mime: string, allowlist: readonly string[]): boolean {
  const normalized = normalizeMime(mime);
  if (!normalized) {
    return false;
  }
  for (const rawRule of allowlist) {
    const rule = normalizeMime(rawRule);
    if (!rule) continue;
    if (rule === '*/*' || rule === normalized) {
      return true;
    }
    if (rule.endsWith('/*')) {
      const prefix = rule.slice(0, -1); // includes trailing '/'
      if (normalized.startsWith(prefix)) {
        return true;
      }
    }
  }
  return false;
}

function matchesExtensionAllowlist(filename: string, allowlist: readonly string[]): boolean {
  const ext = extractExtension(filename);
  if (!ext) {
    return false;
  }
  for (const rawRule of allowlist) {
    const trimmed = rawRule.trim().toLowerCase();
    if (!trimmed) continue;
    const normalizedRule = trimmed.startsWith('.') ? trimmed : `.${trimmed}`;
    if (ext === normalizedRule) {
      return true;
    }
  }
  return false;
}

function startsWithBytes(data: Uint8Array, signature: readonly number[], offset = 0): boolean {
  if (data.byteLength < offset + signature.length) {
    return false;
  }
  for (let i = 0; i < signature.length; i += 1) {
    if (data[offset + i] !== signature[i]) {
      return false;
    }
  }
  return true;
}

/**
 * Verifies leading magic bytes of an uploaded file against its declared MIME type
 * for common binary formats (PNG, JPEG, GIF, WebP, PDF, ZIP, GZIP, MP4, MP3, WAV).
 * Returns `true` for plain text / unknown MIME types that lack fixed magic headers.
 */
export function verifyUploadMagicBytes(bytes: Uint8Array, declaredMimeType: string): boolean {
  const mime = normalizeMime(declaredMimeType);

  switch (mime) {
    case 'image/png':
      return startsWithBytes(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    case 'image/jpeg':
    case 'image/jpg':
      return startsWithBytes(bytes, [0xff, 0xd8, 0xff]);
    case 'image/gif':
      return (
        startsWithBytes(bytes, [0x47, 0x49, 0x46, 0x38, 0x37, 0x61]) ||
        startsWithBytes(bytes, [0x47, 0x49, 0x46, 0x38, 0x39, 0x61])
      );
    case 'image/webp':
      return (
        startsWithBytes(bytes, [0x52, 0x49, 0x46, 0x46], 0) &&
        startsWithBytes(bytes, [0x57, 0x45, 0x42, 0x50], 8)
      );
    case 'application/pdf':
      return startsWithBytes(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d]); // %PDF-
    case 'application/zip':
    case 'application/x-zip-compressed':
      return (
        startsWithBytes(bytes, [0x50, 0x4b, 0x03, 0x04]) ||
        startsWithBytes(bytes, [0x50, 0x4b, 0x05, 0x06]) ||
        startsWithBytes(bytes, [0x50, 0x4b, 0x07, 0x08])
      );
    case 'application/gzip':
    case 'application/x-gzip':
      return startsWithBytes(bytes, [0x1f, 0x8b]);
    case 'video/mp4':
      return startsWithBytes(bytes, [0x66, 0x74, 0x79, 0x70], 4); // ftyp
    case 'audio/mpeg':
      return (
        startsWithBytes(bytes, [0x49, 0x44, 0x33]) || // ID3
        (bytes.byteLength >= 2 && bytes[0] === 0xff && ((bytes[1] ?? 0) & 0xe0) === 0xe0)
      );
    case 'audio/wav':
    case 'audio/wave':
    case 'audio/x-wav':
      return (
        startsWithBytes(bytes, [0x52, 0x49, 0x46, 0x46], 0) &&
        startsWithBytes(bytes, [0x57, 0x41, 0x56, 0x45], 8)
      );
    default:
      return true;
  }
}

export interface UploadValidationRules {
  readonly allowedMimeTypes?: readonly string[];
  readonly allowedExtensions?: readonly string[];
  readonly verifyMagicBytes?: boolean;
}

export function validateUploadMetadata(
  filename: string,
  mimeType: string,
  rules: UploadValidationRules,
): void {
  if (rules.allowedMimeTypes !== undefined && rules.allowedMimeTypes.length > 0) {
    if (!matchesMimeAllowlist(mimeType, rules.allowedMimeTypes)) {
      throw new UnsupportedMediaTypeError(
        `Uploaded file "${filename}" has disallowed MIME type "${mimeType}"`,
      );
    }
  }

  if (rules.allowedExtensions !== undefined && rules.allowedExtensions.length > 0) {
    if (!matchesExtensionAllowlist(filename, rules.allowedExtensions)) {
      throw new UnsupportedMediaTypeError(
        `Uploaded file "${filename}" has a disallowed file extension`,
      );
    }
  }
}

export function validateUploadMagicBytesOrThrow(
  filename: string,
  mimeType: string,
  headerBytes: Uint8Array,
  rules: UploadValidationRules,
): void {
  if (rules.verifyMagicBytes === true && !verifyUploadMagicBytes(headerBytes, mimeType)) {
    throw new UnsupportedMediaTypeError(
      `Uploaded file "${filename}" content does not match declared MIME type "${mimeType}"`,
    );
  }
}
