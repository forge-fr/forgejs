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

export interface CreateSseResponseOptions {
  readonly headers?: HeadersInit;
  readonly signal?: AbortSignal;
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

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const closeStream = (): void => {
        if (closed) return;
        closed = true;
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

      Promise.resolve()
        .then(() => producer(sseController))
        .then(() => {
          closeStream();
        })
        .catch((err: unknown) => {
          if (!closed) {
            closed = true;
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
      if (options.signal && onAbort) {
        options.signal.removeEventListener('abort', onAbort);
        onAbort = null;
      }
    },
  });

  return new Response(stream, { status: 200, headers });
}
