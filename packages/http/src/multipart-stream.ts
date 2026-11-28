import {
  BadRequestError,
  PayloadTooLargeError,
  UnsupportedMediaTypeError,
} from './errors.js';
import type {
  MultipartStreamFieldPart,
  MultipartStreamFilePart,
  MultipartStreamOptions,
  MultipartStreamPart,
} from './types.js';
import {
  sanitizeUploadFilename,
  validateUploadMagicBytesOrThrow,
  validateUploadMetadata,
} from './upload-validation.js';

export type {
  MultipartStreamFieldPart,
  MultipartStreamFilePart,
  MultipartStreamOptions,
  MultipartStreamPart,
};

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const DEFAULT_STREAM_MAX_BYTES = 10 * 1_048_576; // 10 MiB
const DEFAULT_STREAM_MAX_FIELDS = 100;
const DEFAULT_STREAM_MAX_FILES = 10;
const DEFAULT_STREAM_MAX_FILE_BYTES = 5 * 1_048_576; // 5 MiB
const DEFAULT_STREAM_MAX_FIELD_BYTES = 1_048_576; // 1 MiB
const MAX_PART_HEADER_BYTES = 16_384; // 16 KiB per part header block

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder('utf-8', { fatal: false });
const CRLF_CRLF = new Uint8Array([13, 10, 13, 10]);

function indexOfBytes(haystack: Uint8Array, needle: Uint8Array, start = 0): number {
  const nLen = needle.byteLength;
  const hLen = haystack.byteLength;
  if (nLen === 0 || hLen < nLen || start > hLen - nLen) {
    return -1;
  }
  const first = needle[0];
  outer: for (let i = start; i <= hLen - nLen; i += 1) {
    if (haystack[i] !== first) continue;
    for (let j = 1; j < nLen; j += 1) {
      if (haystack[i + j] !== needle[j]) {
        continue outer;
      }
    }
    return i;
  }
  return -1;
}

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (a.byteLength === 0) return b;
  if (b.byteLength === 0) return a;
  const out = new Uint8Array(a.byteLength + b.byteLength);
  out.set(a, 0);
  out.set(b, a.byteLength);
  return out;
}

function extractBoundary(contentType: string): string {
  const match = /;\s*boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType);
  const boundary = (match?.[1] ?? match?.[2] ?? '').trim();
  if (boundary.length === 0 || boundary.length > 70) {
    throw new BadRequestError('Missing or invalid multipart boundary');
  }
  return boundary;
}

interface ParsedPartHeaders {
  readonly fieldName: string;
  readonly rawFilename?: string;
  readonly contentType: string;
}

function parseContentDispositionParam(header: string, paramName: string): string | undefined {
  const quoted = new RegExp(`(?:^|;)\\s*${paramName}="((?:[^"\\\\]|\\\\.)*)"`, 'i').exec(header);
  if (quoted && quoted[1] !== undefined) {
    return quoted[1].replace(/\\(.)/g, '$1');
  }
  const token = new RegExp(`(?:^|;)\\s*${paramName}=([^;\\s]+)`, 'i').exec(header);
  return token?.[1];
}

function parsePartHeaders(rawHeaderText: string): ParsedPartHeaders {
  let contentDisposition = '';
  let contentType = 'application/octet-stream';

  const lines = rawHeaderText.split(/\r\n/);
  for (const line of lines) {
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const name = line.slice(0, colon).trim().toLowerCase();
    const val = line.slice(colon + 1).trim();
    if (name === 'content-disposition') {
      contentDisposition = val;
    } else if (name === 'content-type' && val.length > 0) {
      contentType = val;
    }
  }

  const fieldName = parseContentDispositionParam(contentDisposition, 'name');
  if (!fieldName) {
    throw new BadRequestError('Multipart part missing Content-Disposition name');
  }

  const rawFilename = parseContentDispositionParam(contentDisposition, 'filename');
  return {
    fieldName,
    ...(rawFilename !== undefined ? { rawFilename } : {}),
    contentType,
  };
}

function mergeChunks(chunks: readonly Uint8Array[], totalBytes: number): Uint8Array {
  if (chunks.length === 0) return new Uint8Array(0);
  if (chunks.length === 1) return chunks[0] ?? new Uint8Array(0);
  const out = new Uint8Array(totalBytes);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

/**
 * Incremental RFC 7578 streaming multipart/form-data parser with bounded total bytes,
 * per-file/per-field size enforcement, MIME/extension/magic-byte validation, filename
 * sanitization, and deterministic stream cleanup on early exit or abort.
 *
 * Consumers must either consume or cancel each yielded file part's `stream` (or call
 * `part.bytes()` / `part.text()`) before advancing to the next part.
 */
export async function* readMultipartStream(
  request: Request,
  options: MultipartStreamOptions = {},
): AsyncGenerator<MultipartStreamPart, void, void> {
  const contentType = request.headers.get('content-type');
  const mediaType = contentType?.split(';', 1)[0]?.trim().toLowerCase() ?? '';
  if (mediaType !== 'multipart/form-data' || contentType === null) {
    throw new UnsupportedMediaTypeError(
      `Expected multipart/form-data content-type, received "${contentType ?? 'none'}"`,
    );
  }

  const boundary = extractBoundary(contentType);
  const maxBytes = options.maxBytes ?? DEFAULT_STREAM_MAX_BYTES;
  const maxFields = options.maxFields ?? DEFAULT_STREAM_MAX_FIELDS;
  const maxFiles = options.maxFiles ?? DEFAULT_STREAM_MAX_FILES;
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_STREAM_MAX_FILE_BYTES;
  const maxFieldBytes = options.maxFieldBytes ?? DEFAULT_STREAM_MAX_FIELD_BYTES;
  const shouldSanitizeNames = options.sanitizeFilenames !== false;

  if (!Number.isInteger(maxBytes) || maxBytes < 0) {
    throw new BadRequestError('Invalid maxBytes limit');
  }

  const contentLengthHeader = request.headers.get('content-length');
  if (contentLengthHeader !== null) {
    const declared = Number(contentLengthHeader);
    if (Number.isFinite(declared) && declared > maxBytes) {
      if (request.body !== null) {
        await request.body.cancel().catch(() => {});
      }
      throw new PayloadTooLargeError(maxBytes, `Request body exceeds limit of ${maxBytes} bytes`);
    }
  }

  if (request.body === null) {
    throw new BadRequestError('Empty multipart/form-data body');
  }

  const startBoundary = utf8Encoder.encode(`--${boundary}`);
  const nextBoundary = utf8Encoder.encode(`\r\n--${boundary}`);
  const keepTail = nextBoundary.byteLength + 2;

  const reader = request.body.getReader();
  let buffer: Uint8Array = new Uint8Array(0);
  let totalRead = 0;
  let streamEnded = false;
  let fieldCount = 0;
  let fileCount = 0;
  let activeFileDrain: (() => Promise<void>) | null = null;

  async function pullChunk(): Promise<boolean> {
    if (streamEnded) {
      return false;
    }
    const { done, value } = await reader.read();
    if (done) {
      streamEnded = true;
      return false;
    }
    if (value && value.byteLength > 0) {
      totalRead += value.byteLength;
      if (totalRead > maxBytes) {
        throw new PayloadTooLargeError(maxBytes, `Request body exceeds limit of ${maxBytes} bytes`);
      }
      buffer = concatBytes(buffer, value);
    }
    return true;
  }

  async function ensureBytes(minLength: number): Promise<boolean> {
    while (buffer.byteLength < minLength) {
      const got = await pullChunk();
      if (!got) {
        return buffer.byteLength >= minLength;
      }
    }
    return true;
  }

  try {
    // 1. Locate initial boundary "--<boundary>"
    let startIdx = -1;
    while ((startIdx = indexOfBytes(buffer, startBoundary)) === -1) {
      if (buffer.byteLength > MAX_PART_HEADER_BYTES) {
        throw new BadRequestError('Malformed multipart/form-data preamble');
      }
      const got = await pullChunk();
      if (!got) {
        throw new BadRequestError('Multipart boundary not found in request body');
      }
    }

    buffer = buffer.subarray(startIdx + startBoundary.byteLength);

    // 2. Iterate parts until "--<boundary>--"
    while (true) {
      if (activeFileDrain !== null) {
        const drain = activeFileDrain;
        activeFileDrain = null;
        await drain();
      }

      if (!(await ensureBytes(2))) {
        throw new BadRequestError('Unexpected end of multipart stream after boundary');
      }

      // Closing boundary "--"
      if (buffer[0] === 45 && buffer[1] === 45) {
        break;
      }

      // Expect "\r\n" after boundary
      if (buffer[0] !== 13 || buffer[1] !== 10) {
        throw new BadRequestError('Malformed multipart boundary terminator');
      }
      buffer = buffer.subarray(2);

      // Read part headers up to "\r\n\r\n"
      let headerEnd = -1;
      while ((headerEnd = indexOfBytes(buffer, CRLF_CRLF)) === -1) {
        if (buffer.byteLength > MAX_PART_HEADER_BYTES) {
          throw new BadRequestError('Multipart part headers exceed maximum allowed size');
        }
        const got = await pullChunk();
        if (!got) {
          throw new BadRequestError('Unexpected end of multipart stream in part headers');
        }
      }

      const headerText = utf8Decoder.decode(buffer.subarray(0, headerEnd));
      buffer = buffer.subarray(headerEnd + 4);

      const partMeta = parsePartHeaders(headerText);
      const isFile = partMeta.rawFilename !== undefined;

      if (!isFile) {
        // Text field: read up to nextBoundary
        const fieldChunks: Uint8Array[] = [];
        let fieldBytes = 0;

        while (true) {
          const bIdx = indexOfBytes(buffer, nextBoundary);
          if (bIdx !== -1) {
            if (bIdx > 0) {
              fieldBytes += bIdx;
              if (fieldBytes > maxFieldBytes) {
                throw new PayloadTooLargeError(
                  maxFieldBytes,
                  `Multipart field "${partMeta.fieldName}" exceeds limit of ${maxFieldBytes} bytes`,
                );
              }
              fieldChunks.push(buffer.slice(0, bIdx));
            }
            buffer = buffer.subarray(bIdx + nextBoundary.byteLength);
            break;
          }

          if (buffer.byteLength > keepTail) {
            const safeLen = buffer.byteLength - keepTail;
            fieldBytes += safeLen;
            if (fieldBytes > maxFieldBytes) {
              throw new PayloadTooLargeError(
                maxFieldBytes,
                `Multipart field "${partMeta.fieldName}" exceeds limit of ${maxFieldBytes} bytes`,
              );
            }
            fieldChunks.push(buffer.slice(0, safeLen));
            buffer = buffer.subarray(safeLen);
          }

          const got = await pullChunk();
          if (!got) {
            throw new BadRequestError('Unexpected end of multipart stream while reading field');
          }
        }

        if (FORBIDDEN_KEYS.has(partMeta.fieldName)) {
          continue;
        }
        fieldCount += 1;
        if (fieldCount > maxFields) {
          throw new BadRequestError(`Multipart field count exceeds limit of ${maxFields}`);
        }

        const mergedField = mergeChunks(fieldChunks, fieldBytes);
        yield {
          kind: 'field',
          fieldName: partMeta.fieldName,
          value: utf8Decoder.decode(mergedField),
        };
      } else {
        // File part: validate metadata & limits first
        fileCount += 1;
        if (fileCount > maxFiles) {
          throw new BadRequestError(`Multipart file count exceeds limit of ${maxFiles}`);
        }

        const rawName = partMeta.rawFilename ?? 'upload';
        const safeName = shouldSanitizeNames ? sanitizeUploadFilename(rawName) : rawName;
        validateUploadMetadata(safeName, partMeta.contentType, options);

        let fileBytesRead = 0;
        let partFinished = false;
        let headerChecked = options.verifyMagicBytes !== true;
        let magicBuffer: Uint8Array = new Uint8Array(0);

        const readNextFileChunk = async (): Promise<Uint8Array | null> => {
          if (partFinished) {
            return null;
          }
          while (true) {
            const bIdx = indexOfBytes(buffer, nextBoundary);
            if (bIdx !== -1) {
              const tail = bIdx > 0 ? buffer.slice(0, bIdx) : null;
              buffer = buffer.subarray(bIdx + nextBoundary.byteLength);
              partFinished = true;
              if (tail !== null) {
                fileBytesRead += tail.byteLength;
                if (fileBytesRead > maxFileBytes) {
                  throw new PayloadTooLargeError(
                    maxFileBytes,
                    `Uploaded file "${safeName}" exceeds limit of ${maxFileBytes} bytes`,
                  );
                }
                if (!headerChecked) {
                  magicBuffer = concatBytes(magicBuffer, tail);
                  headerChecked = true;
                  validateUploadMagicBytesOrThrow(safeName, partMeta.contentType, magicBuffer, options);
                }
                return tail;
              }
              if (!headerChecked) {
                headerChecked = true;
                validateUploadMagicBytesOrThrow(safeName, partMeta.contentType, magicBuffer, options);
              }
              return null;
            }

            if (buffer.byteLength > keepTail) {
              const safeLen = buffer.byteLength - keepTail;
              const emit = buffer.slice(0, safeLen);
              buffer = buffer.subarray(safeLen);
              fileBytesRead += emit.byteLength;
              if (fileBytesRead > maxFileBytes) {
                throw new PayloadTooLargeError(
                  maxFileBytes,
                  `Uploaded file "${safeName}" exceeds limit of ${maxFileBytes} bytes`,
                );
              }
              if (!headerChecked) {
                magicBuffer = concatBytes(magicBuffer, emit);
                if (magicBuffer.byteLength >= 16) {
                  headerChecked = true;
                  validateUploadMagicBytesOrThrow(safeName, partMeta.contentType, magicBuffer, options);
                }
              }
              return emit;
            }

            const got = await pullChunk();
            if (!got) {
              throw new BadRequestError('Unexpected end of multipart stream while reading file');
            }
          }
        };

        // Pre-validate magic bytes up front when verifyMagicBytes is enabled so spoofed
        // uploads fail immediately before yielding the file stream to the caller.
        const prefetched: Uint8Array[] = [];
        if (options.verifyMagicBytes === true) {
          let prefetchedLen = 0;
          while (!partFinished && prefetchedLen < 16) {
            const chunk = await readNextFileChunk();
            if (chunk === null) break;
            prefetched.push(chunk);
            prefetchedLen += chunk.byteLength;
          }
          if (!headerChecked) {
            headerChecked = true;
            validateUploadMagicBytesOrThrow(safeName, partMeta.contentType, magicBuffer, options);
          }
        }

        let prefetchIdx = 0;
        const fileStream = new ReadableStream<Uint8Array>({
          async pull(controller) {
            if (prefetchIdx < prefetched.length) {
              const nextChunk = prefetched[prefetchIdx++];
              if (nextChunk !== undefined) {
                controller.enqueue(nextChunk);
                return;
              }
            }
            const chunk = await readNextFileChunk();
            if (chunk === null) {
              controller.close();
              return;
            }
            controller.enqueue(chunk);
          },
          async cancel() {
            while (!partFinished) {
              const discarded = await readNextFileChunk();
              if (discarded === null) break;
            }
          },
        });

        activeFileDrain = async () => {
          if (partFinished) return;
          while (!partFinished) {
            const discarded = await readNextFileChunk();
            if (discarded === null) break;
          }
        };

        const collectFileBytes = async (): Promise<Uint8Array> => {
          const r = fileStream.getReader();
          const parts: Uint8Array[] = [];
          let total = 0;
          try {
            while (true) {
              const { done, value } = await r.read();
              if (done) break;
              if (value) {
                parts.push(value);
                total += value.byteLength;
              }
            }
          } finally {
            r.releaseLock();
          }
          return mergeChunks(parts, total);
        };

        yield {
          kind: 'file',
          fieldName: partMeta.fieldName,
          name: safeName,
          rawName,
          type: partMeta.contentType,
          stream: fileStream,
          bytes: collectFileBytes,
          text: async () => utf8Decoder.decode(await collectFileBytes()),
        };
      }
    }
  } finally {
    try {
      if (!streamEnded) {
        await reader.cancel('Multipart stream finished');
      }
    } catch {
      // Ignore cancellation errors on already-closed streams
    } finally {
      reader.releaseLock();
    }
  }
}
