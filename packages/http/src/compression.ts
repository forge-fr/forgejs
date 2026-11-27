import { attachFastBody, getFastBody } from './fast-body.js';
import type { ForgeMiddleware } from './types.js';

export type SupportedCompressionEncoding = 'gzip' | 'deflate';

export interface CompressionOptions {
  /** Minimum uncompressed body byte length before compressing. Default: `1024`. */
  readonly thresholdBytes?: number;
  /** Maximum uncompressed body bytes buffered for threshold/compression. Larger bodies pass through uncompressed. Default: `10485760` (10 MiB). */
  readonly maxBytes?: number;
  /** Preferred server encoding order. Default: `['gzip', 'deflate']`. */
  readonly encodings?: readonly SupportedCompressionEncoding[];
  /** Custom MIME prefix/exact match filter. Defaults to JSON, text/*, XML, SVG, JS, WASM. */
  readonly filter?: (contentType: string) => boolean;
}

const DEFAULT_THRESHOLD_BYTES = 1024;
const DEFAULT_MAX_COMPRESS_BYTES = 10 * 1024 * 1024;
const DEFAULT_ENCODINGS: readonly SupportedCompressionEncoding[] = ['gzip', 'deflate'];
const utf8Encoder = new TextEncoder();

function isCompressibleContentType(contentType: string): boolean {
  const mediaType = contentType.split(';', 1)[0]?.trim().toLowerCase() ?? '';
  if (!mediaType || mediaType === 'text/event-stream') {
    return false;
  }
  if (mediaType.startsWith('text/')) {
    return true;
  }
  return (
    mediaType === 'application/json' ||
    mediaType.endsWith('+json') ||
    mediaType === 'application/javascript' ||
    mediaType === 'application/xml' ||
    mediaType.endsWith('+xml') ||
    mediaType === 'application/wasm'
  );
}

function selectAcceptedEncoding(
  acceptEncodingHeader: string | null,
  preferred: readonly SupportedCompressionEncoding[],
): SupportedCompressionEncoding | null {
  if (!acceptEncodingHeader) {
    return null;
  }

  const normalized = acceptEncodingHeader.toLowerCase();
  const qValues = new Map<string, number>();

  for (const part of normalized.split(',')) {
    const segments = part.trim().split(';');
    const token = segments[0]?.trim();
    if (!token) continue;

    let q = 1;
    for (let i = 1; i < segments.length; i += 1) {
      const param = segments[i]?.trim();
      if (param?.startsWith('q=')) {
        const parsed = Number(param.slice(2));
        q = Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : 0;
      }
    }
    qValues.set(token, q);
  }

  const wildcardQ = qValues.get('*') ?? 0;
  let bestEncoding: SupportedCompressionEncoding | null = null;
  let bestQ = 0;

  for (const candidate of preferred) {
    const explicitQ = qValues.get(candidate);
    const effectiveQ = explicitQ !== undefined ? explicitQ : wildcardQ;
    if (effectiveQ > bestQ) {
      bestQ = effectiveQ;
      bestEncoding = candidate;
    }
  }

  return bestQ > 0 ? bestEncoding : null;
}

function appendVary(headers: Headers, value: string): void {
  const existing = headers.get('vary');
  if (!existing) {
    headers.set('vary', value);
    return;
  }
  const tokens = existing
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  if (!tokens.includes(value.toLowerCase())) {
    headers.set('vary', `${existing}, ${value}`);
  }
}

function weakenStrongEtag(headers: Headers): void {
  const existing = headers.get('etag');
  if (existing && !existing.startsWith('W/')) {
    headers.set('etag', `W/${existing}`);
  }
}

function rebuildStreamWithPrefix(
  prefixChunks: readonly Uint8Array[],
  reader: ReadableStreamDefaultReader<Uint8Array>,
): ReadableStream<Uint8Array> {
  let index = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (index < prefixChunks.length) {
        controller.enqueue(prefixChunks[index]!);
        index += 1;
        return;
      }
      const { done, value } = await reader.read();
      if (done) {
        reader.releaseLock();
        controller.close();
        return;
      }
      if (value) {
        controller.enqueue(value);
      }
    },
    async cancel(reason) {
      await reader.cancel(reason).catch(() => {});
      try {
        reader.releaseLock();
      } catch {
        // Ignore already released lock
      }
    },
  });
}

async function readBoundedOrPassthrough(
  response: Response,
  maxBytes: number,
): Promise<{ readonly bytes: Uint8Array; readonly exceeded: false } | { readonly stream: ReadableStream<Uint8Array>; readonly exceeded: true }> {
  const body = response.body!;
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      reader.releaseLock();
      break;
    }
    if (!value || value.byteLength === 0) {
      continue;
    }
    chunks.push(value);
    total += value.byteLength;
    if (total > maxBytes) {
      return {
        exceeded: true,
        stream: rebuildStreamWithPrefix(chunks, reader),
      };
    }
  }

  if (chunks.length === 1) {
    return { exceeded: false, bytes: chunks[0]! };
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { exceeded: false, bytes: merged };
}

export function createCompressionMiddleware(options: CompressionOptions = {}): ForgeMiddleware {
  const thresholdBytes = options.thresholdBytes ?? DEFAULT_THRESHOLD_BYTES;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_COMPRESS_BYTES;
  const encodings = options.encodings ?? DEFAULT_ENCODINGS;
  const filter = options.filter ?? isCompressibleContentType;

  return async function compressionMiddleware(ctx, next) {
    const response = await next();

    if (
      ctx.method === 'HEAD' ||
      response.status === 204 ||
      response.status === 304 ||
      response.headers.has('content-encoding')
    ) {
      return response;
    }

    const contentType = response.headers.get('content-type') ?? '';
    if (!filter(contentType)) {
      return response;
    }

    const encoding = selectAcceptedEncoding(ctx.header('accept-encoding'), encodings);
    if (!encoding || typeof CompressionStream !== 'function') {
      return response;
    }

    const declaredLenHeader = response.headers.get('content-length');
    if (declaredLenHeader !== null) {
      const declaredLen = Number(declaredLenHeader);
      if (Number.isFinite(declaredLen) && (declaredLen < thresholdBytes || declaredLen > maxBytes)) {
        return response;
      }
    }

    const fastBody = getFastBody(response);
    let rawBytes: Uint8Array;
    if (fastBody !== undefined) {
      rawBytes = typeof fastBody === 'string' ? utf8Encoder.encode(fastBody) : fastBody;
      if (rawBytes.byteLength > maxBytes) {
        return response;
      }
    } else if (response.body === null) {
      return response;
    } else {
      const bounded = await readBoundedOrPassthrough(response, maxBytes);
      if (bounded.exceeded) {
        return new Response(bounded.stream, {
          status: response.status,
          statusText: response.statusText,
          headers: new Headers(response.headers),
        });
      }
      rawBytes = bounded.bytes;
    }

    if (rawBytes.byteLength < thresholdBytes) {
      if (fastBody !== undefined) {
        return response;
      }
      const copy = new Uint8Array(rawBytes.byteLength);
      copy.set(rawBytes);
      return attachFastBody(
        new Response(copy, {
          status: response.status,
          statusText: response.statusText,
          headers: new Headers(response.headers),
        }),
        copy,
      );
    }

    const copyForStream = new Uint8Array(rawBytes.byteLength);
    copyForStream.set(rawBytes);

    const compressedStream = new Blob([copyForStream])
      .stream()
      .pipeThrough(new CompressionStream(encoding) as unknown as TransformStream<Uint8Array, Uint8Array>);

    const compressedBytes = new Uint8Array(await new Response(compressedStream).arrayBuffer());
    const headers = new Headers(response.headers);
    headers.set('content-encoding', encoding);
    headers.set('content-length', String(compressedBytes.byteLength));
    appendVary(headers, 'Accept-Encoding');
    weakenStrongEtag(headers);

    return attachFastBody(
      new Response(compressedBytes, {
        status: response.status,
        statusText: response.statusText,
        headers,
      }),
      compressedBytes,
    );
  };
}
