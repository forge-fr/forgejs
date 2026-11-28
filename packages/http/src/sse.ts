import { BadRequestError } from './errors.js';
import type { SseEvent, SseProducer, SseStreamController } from './types.js';

const utf8Encoder = new TextEncoder();
const CONTROL_CHAR_REGEX = /[\r\n\0]/;

function assertSafeSseField(fieldName: string, value: string): void {
  if (CONTROL_CHAR_REGEX.test(value)) {
    throw new BadRequestError(`SSE "${fieldName}" field must not contain CR, LF, or NUL bytes`);
  }
}

export function formatSseEvent(event: SseEvent): string {
  const lines: string[] = [];

  if (event.id !== undefined) {
    assertSafeSseField('id', event.id);
    lines.push(`id: ${event.id}`);
  }

  if (event.event !== undefined) {
    assertSafeSseField('event', event.event);
    lines.push(`event: ${event.event}`);
  }

  if (event.retry !== undefined) {
    if (!Number.isInteger(event.retry) || event.retry < 0) {
      throw new BadRequestError('SSE "retry" must be a non-negative integer');
    }
    lines.push(`retry: ${event.retry}`);
  }

  const serialized =
    typeof event.data === 'string' ? event.data : JSON.stringify(event.data ?? null);
  const dataLines = serialized.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  for (const line of dataLines) {
    lines.push(`data: ${line}`);
  }

  return `${lines.join('\n')}\n\n`;
}

export interface ExtractLastEventIdSource {
  readonly headers: Headers;
  readonly query?: Readonly<Record<string, string>>;
}

/**
 * Safely extracts the client's `Last-Event-ID` header (or `lastEventId` query fallback)
 * while stripping unsafe CR/LF/NUL characters.
 */
export function extractLastEventId(
  source: Request | Headers | ExtractLastEventIdSource,
): string | undefined {
  let raw: string | null | undefined;
  if (
    source instanceof Headers ||
    ('get' in source && typeof source.get === 'function' && !('headers' in source))
  ) {
    raw = source.get('last-event-id');
  } else if (source instanceof Request) {
    raw = source.headers.get('last-event-id');
    if (!raw) {
      try {
        const url = new URL(source.url, 'http://localhost');
        raw = url.searchParams.get('lastEventId') ?? url.searchParams.get('last_event_id');
      } catch {
        // Ignore invalid URL
      }
    }
  } else {
    raw =
      source.headers.get('last-event-id') ??
      source.query?.['lastEventId'] ??
      source.query?.['last_event_id'];
  }

  if (typeof raw !== 'string') {
    return undefined;
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0 || CONTROL_CHAR_REGEX.test(trimmed)) {
    return undefined;
  }
  return trimmed;
}

export interface BufferedSseEvent<T = unknown> extends SseEvent {
  readonly id: string;
  readonly data: T;
  readonly timestamp: number;
}

export interface SseEventBufferOptions {
  /** Maximum number of events retained in the replay ring buffer (default: `256`). */
  readonly maxEvents?: number;
  /** Maximum event age in milliseconds before eviction (default: `300_000` = 5 minutes). */
  readonly ttlMs?: number;
  /** Optional prefix for auto-generated event IDs (default: `'evt_'`). */
  readonly idPrefix?: string;
  /** Optional injectable clock for deterministic tests (default: `Date.now`). */
  readonly clock?: () => number;
}

export interface SseEventBuffer<T = unknown> {
  append(event: Omit<SseEvent, 'id' | 'data'> & { readonly id?: string; readonly data: T }): BufferedSseEvent<T>;
  replaySince(lastEventId: string | undefined): readonly BufferedSseEvent<T>[];
  replayTo(stream: SseStreamController, lastEventId?: string): number;
  size(): number;
  clear(): void;
}

export function createSseEventBuffer<T = unknown>(
  options: SseEventBufferOptions = {},
): SseEventBuffer<T> {
  const maxEvents = Math.max(1, options.maxEvents ?? 256);
  const ttlMs = Math.max(1, options.ttlMs ?? 300_000);
  const idPrefix = options.idPrefix ?? 'evt_';
  const clock = options.clock ?? (() => Date.now());
  let seq = 0;
  const entries: BufferedSseEvent<T>[] = [];

  function pruneExpired(now: number): void {
    const cutoff = now - ttlMs;
    while (entries.length > 0 && (entries[0]?.timestamp ?? 0) < cutoff) {
      entries.shift();
    }
    while (entries.length > maxEvents) {
      entries.shift();
    }
  }

  return {
    append(event): BufferedSseEvent<T> {
      const now = clock();
      pruneExpired(now);
      seq += 1;
      const id = event.id ?? `${idPrefix}${seq}`;
      assertSafeSseField('id', id);
      if (event.event !== undefined) {
        assertSafeSseField('event', event.event);
      }
      const record: BufferedSseEvent<T> = Object.freeze({
        id,
        data: event.data,
        timestamp: now,
        ...(event.event !== undefined ? { event: event.event } : {}),
        ...(event.retry !== undefined ? { retry: event.retry } : {}),
      });
      entries.push(record);
      if (entries.length > maxEvents) {
        entries.shift();
      }
      return record;
    },

    replaySince(lastEventId: string | undefined): readonly BufferedSseEvent<T>[] {
      if (!lastEventId) {
        return [];
      }
      pruneExpired(clock());
      const idx = entries.findIndex((e) => e.id === lastEventId);
      if (idx === -1) {
        return [];
      }
      return entries.slice(idx + 1);
    },

    replayTo(stream: SseStreamController, explicitLastEventId?: string): number {
      const targetId = explicitLastEventId ?? stream.lastEventId;
      const missed = this.replaySince(targetId);
      for (const evt of missed) {
        if (stream.closed) {
          break;
        }
        stream.send(evt);
      }
      return missed.length;
    },

    size(): number {
      pruneExpired(clock());
      return entries.length;
    },

    clear(): void {
      entries.length = 0;
    },
  };
}

export interface CreateSseResponseOptions {
  readonly headers?: HeadersInit;
  readonly signal?: AbortSignal;
  /** Optional client `Last-Event-ID` value passed from `Last-Event-ID` request header. */
  readonly lastEventId?: string | undefined;
  /** Optional automatic keepalive comment interval in milliseconds (e.g. `15_000`). */
  readonly keepAliveIntervalMs?: number;
  /** Optional comment text sent on each keepalive tick (default: `'keepalive'`). */
  readonly keepAliveComment?: string;
  /** Optional initial reconnection retry interval (`retry: <ms>`) sent when the stream opens. */
  readonly retryMs?: number;
}

export function createSseResponse(
  producer: SseProducer,
  options: CreateSseResponseOptions = {},
): Response {
  const headers = new Headers(options.headers);
  if (!headers.has('content-type')) {
    headers.set('content-type', 'text/event-stream; charset=utf-8');
  }
  if (!headers.has('cache-control')) {
    headers.set('cache-control', 'no-cache, no-transform');
  }
  if (!headers.has('connection')) {
    headers.set('connection', 'keep-alive');
  }

  let closed = false;
  let onAbort: (() => void) | null = null;
  let keepAliveTimer: ReturnType<typeof setInterval> | null = null;

  const stopKeepAlive = (): void => {
    if (keepAliveTimer !== null) {
      clearInterval(keepAliveTimer);
      keepAliveTimer = null;
    }
  };

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const closeStream = (): void => {
        if (closed) return;
        closed = true;
        stopKeepAlive();
        if (options.signal && onAbort) {
          options.signal.removeEventListener('abort', onAbort);
          onAbort = null;
        }
        try {
          controller.close();
        } catch {
          // Stream already closed or errored
        }
      };

      const sseController: SseStreamController = {
        get closed(): boolean {
          return closed;
        },
        ...(options.lastEventId !== undefined ? { lastEventId: options.lastEventId } : {}),
        send(event: SseEvent): void {
          if (closed) return;
          const payload = formatSseEvent(event);
          controller.enqueue(utf8Encoder.encode(payload));
        },
        comment(text: string): void {
          if (closed) return;
          const sanitized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
          const frame = sanitized.map((line) => `: ${line}`).join('\n') + '\n\n';
          controller.enqueue(utf8Encoder.encode(frame));
        },
        close: closeStream,
      };

      if (options.signal) {
        if (options.signal.aborted) {
          closeStream();
          return;
        }
        onAbort = closeStream;
        options.signal.addEventListener('abort', onAbort, { once: true });
      }

      if (options.retryMs !== undefined) {
        if (!Number.isInteger(options.retryMs) || options.retryMs < 0) {
          throw new BadRequestError('SSE "retryMs" must be a non-negative integer');
        }
        controller.enqueue(utf8Encoder.encode(`retry: ${options.retryMs}\n\n`));
      }

      if (
        options.keepAliveIntervalMs !== undefined &&
        Number.isFinite(options.keepAliveIntervalMs) &&
        options.keepAliveIntervalMs > 0
      ) {
        const commentText = options.keepAliveComment ?? 'keepalive';
        keepAliveTimer = setInterval(() => {
          if (closed) {
            stopKeepAlive();
            return;
          }
          try {
            sseController.comment(commentText);
          } catch {
            closeStream();
          }
        }, options.keepAliveIntervalMs);
        if (typeof keepAliveTimer === 'object' && keepAliveTimer !== null && 'unref' in keepAliveTimer) {
          (keepAliveTimer as { unref?: () => void }).unref?.();
        }
      }

      Promise.resolve()
        .then(() => producer(sseController))
        .then(() => {
          closeStream();
        })
        .catch((err: unknown) => {
          if (!closed) {
            closed = true;
            stopKeepAlive();
            if (options.signal && onAbort) {
              options.signal.removeEventListener('abort', onAbort);
              onAbort = null;
            }
            controller.error(err);
          }
        });
    },
    cancel() {
      closed = true;
      stopKeepAlive();
      if (options.signal && onAbort) {
        options.signal.removeEventListener('abort', onAbort);
        onAbort = null;
      }
    },
  });

  return new Response(stream, { status: 200, headers });
}
