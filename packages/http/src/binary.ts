import { sanitizeUploadFilename } from './upload-validation.js';

export type BinaryBodyInput = Uint8Array | ArrayBuffer | Blob;

export type ContentDispositionType = 'attachment' | 'inline';

export interface BinaryResponseOptions {
  readonly contentType?: string;
  readonly status?: number;
  readonly headers?: HeadersInit;
  readonly cacheControl?: string;
  readonly etag?: string;
}

export interface DownloadResponseOptions extends BinaryResponseOptions {
  /** Content-Disposition mode (`'attachment'` forces download, `'inline'` displays in browser). Default: `'attachment'`. */
  readonly disposition?: ContentDispositionType;
  /** Optional explicit Content-Length when streaming from a `ReadableStream`. */
  readonly contentLength?: number;
}

function encodeRfc5987(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/**
 * Formats an RFC 6266 / RFC 5987 safe `Content-Disposition` header value, neutralizing
 * path traversal, header injection (`\r`, `\n`, `\0`), quotes, and non-ASCII characters.
 */
export function formatContentDisposition(
  filename: string,
  disposition: ContentDispositionType = 'attachment',
): string {
  const safeName = sanitizeUploadFilename(filename, 'download');
  const asciiFallback = safeName
    .replace(/[^\x20-\x7e]/g, '_')
    .replace(/["\\]/g, '_')
    .trim() || 'download';

  const mode: ContentDispositionType = disposition === 'inline' ? 'inline' : 'attachment';
  if (asciiFallback === safeName) {
    return `${mode}; filename="${asciiFallback}"`;
  }
  return `${mode}; filename="${asciiFallback}"; filename*=UTF-8''${encodeRfc5987(safeName)}`;
}

/**
 * Normalizes `Uint8Array | ArrayBuffer | Blob` into a safe body + byte length.
 */
export function normalizeBinaryInput(input: BinaryBodyInput): {
  readonly body: Uint8Array | Blob;
  readonly byteLength: number;
  readonly inferredContentType?: string;
} {
  if (input instanceof Uint8Array) {
    const copy = new Uint8Array(input.byteLength);
    copy.set(input);
    return { body: copy, byteLength: copy.byteLength };
  }
  if (input instanceof ArrayBuffer) {
    const copy = new Uint8Array(input.byteLength);
    copy.set(new Uint8Array(input));
    return { body: copy, byteLength: copy.byteLength };
  }
  return {
    body: input,
    byteLength: input.size,
    ...(input.type ? { inferredContentType: input.type } : {}),
  };
}

/**
 * Wraps a `ReadableStream<Uint8Array>` so that aborting the request `AbortSignal`
 * cleanly cancels the underlying reader without leaving dangling listeners or handles.
 */
export function wrapAbortableStream(
  source: ReadableStream<Uint8Array>,
  signal: AbortSignal | undefined,
): ReadableStream<Uint8Array> {
  if (signal === undefined) {
    return source;
  }

  if (signal.aborted) {
    source.cancel('Client disconnected').catch(() => {});
    return new ReadableStream<Uint8Array>({
      start(controller) {
        controller.close();
      },
    });
  }

  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  let streamController: ReadableStreamDefaultController<Uint8Array> | null = null;
  let closed = false;

  const cleanup = (): void => {
    signal.removeEventListener('abort', onAbort);
  };

  const onAbort = (): void => {
    if (closed) return;
    closed = true;
    cleanup();
    if (reader !== null) {
      reader.cancel('Client disconnected').catch(() => {});
    } else {
      source.cancel('Client disconnected').catch(() => {});
    }
    if (streamController !== null) {
      try {
        streamController.close();
      } catch {
        // Controller may already be closed or errored
      }
    }
  };

  signal.addEventListener('abort', onAbort, { once: true });

  return new ReadableStream<Uint8Array>({
    start(controller) {
      streamController = controller;
      reader = source.getReader();
    },
    async pull(controller) {
      if (closed || reader === null) {
        try {
          controller.close();
        } catch {
          // Already closed on abort
        }
        return;
      }
      try {
        const { done, value } = await reader.read();
        if (done) {
          closed = true;
          cleanup();
          reader.releaseLock();
          controller.close();
          return;
        }
        if (value) {
          controller.enqueue(value);
        }
      } catch (err) {
        closed = true;
        cleanup();
        try {
          reader.releaseLock();
        } catch {
          // Ignore lock release errors
        }
        controller.error(err);
      }
    },
    async cancel(reason) {
      closed = true;
      cleanup();
      if (reader !== null) {
        try {
          await reader.cancel(reason);
        } finally {
          try {
            reader.releaseLock();
          } catch {
            // Ignore lock release errors
          }
        }
      } else {
        await source.cancel(reason);
      }
    },
  });
}
