import { createNoopLogger, createToken, defineModule } from '@forge-fr/core';
import { createHttpApp, type HttpRuntimeAdapter } from '@forge-fr/http';

export interface AdapterContractCheckResult {
  readonly name: string;
  readonly passed: boolean;
}

function assertCondition(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(`Adapter contract assertion failed: ${message}`);
  }
}

function assertEqual<T>(actual: T, expected: T, label: string): void {
  if (actual !== expected) {
    throw new Error(
      `Adapter contract mismatch (${label}): expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

/**
 * Shared HTTP adapter contract test suite designed to run identically over real
 * loopback sockets on both Node.js (`@forge-fr/node`) and Bun (`@forge-fr/bun`).
 */
export async function runHttpAdapterContractSuite(
  createAdapter: () => HttpRuntimeAdapter,
): Promise<readonly AdapterContractCheckResult[]> {
  const results: AdapterContractCheckResult[] = [];

  async function runCase(name: string, fn: () => Promise<void>): Promise<void> {
    await fn();
    results.push({ name, passed: true });
  }

  const GreeterToken = createToken<{ greet(name: string): string }>('ContractGreeter');
  const GreeterModule = defineModule({
    name: 'contract-greeter',
    providers: [
      {
        token: GreeterToken,
        useValue: { greet: (name: string) => `Hi ${name}` },
      },
    ],
    exports: [GreeterToken],
  });

  let abortObserved = false;
  let releaseSlowRequest: (() => void) | null = null;
  let slowRequestStarted: (() => void) | null = null;

  const adapter = createAdapter();
  const app = createHttpApp({
    adapter,
    logger: createNoopLogger(),
    modules: [GreeterModule],
    maxBodyBytes: 256,
  });

  app.get('/users/:id', (ctx) => {
    const greeter = ctx.resolve(GreeterToken);
    return ctx.json({
      id: ctx.params.id,
      greeting: greeter.greet(ctx.query.name ?? 'guest'),
      remoteAddress: ctx.remoteAddress ?? null,
      runtime: ctx.runtime,
      requestId: ctx.requestId,
    });
  });

  app.post('/echo', async (ctx) => {
    const payload = await ctx.body.json<{ message: string }>();
    return ctx.status(201).json({ echoed: payload.message });
  });

  app.delete('/items/:id', (ctx) => ctx.empty(204));

  app.get('/cookies', (ctx) => {
    ctx.appendHeader('set-cookie', 'a=1; HttpOnly; Path=/');
    ctx.appendHeader('set-cookie', 'b=2; HttpOnly; Path=/');
    return ctx.json({ ok: true });
  });

  app.get('/stream', (ctx) => {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(encoder.encode('chunk-1|'));
        await new Promise((r) => setTimeout(r, 10));
        controller.enqueue(encoder.encode('chunk-2'));
        controller.close();
      },
    });
    return ctx.stream(body, 'text/plain; charset=utf-8');
  });

  app.get('/sse', (ctx) =>
    ctx.sse(async (stream) => {
      stream.send({ id: '1', event: 'tick', data: { n: 1 } });
      await new Promise((r) => setTimeout(r, 10));
      stream.send({ id: '2', event: 'tick', data: { n: 2 } });
      stream.close();
    }),
  );

  app.post('/upload', async (ctx) => {
    const form = await ctx.body.multipart({ maxBytes: 4096, maxFiles: 2, maxFileBytes: 1024 });
    const file = form.files[0];
    return ctx.json({
      label: form.fields.label ?? null,
      fileName: file?.name ?? null,
      content: file ? await file.text() : null,
    });
  });

  app.get('/abort-watch', (ctx) => {
    ctx.signal.addEventListener(
      'abort',
      () => {
        abortObserved = true;
      },
      { once: true },
    );

    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('open\n'));
        const timer = setInterval(() => {
          if (ctx.signal.aborted) {
            clearInterval(timer);
            try {
              controller.close();
            } catch {
              // ignore already closed stream
            }
          }
        }, 15);
        ctx.signal.addEventListener(
          'abort',
          () => {
            clearInterval(timer);
            try {
              controller.close();
            } catch {
              // ignore
            }
          },
          { once: true },
        );
      },
    });

    return ctx.stream(body, 'text/plain; charset=utf-8');
  });

  app.get('/slow', async (ctx) => {
    slowRequestStarted?.();
    await new Promise<void>((resolve) => {
      releaseSlowRequest = resolve;
    });
    return ctx.json({ drained: true });
  });

  const addr = await app.listen({
    host: '127.0.0.1',
    port: 0,
    maxBodyBytes: 4096,
    shutdownTimeoutMs: 2000,
  });

  try {
    await runCase('GET JSON with params, query, DI module, remoteAddress, and x-request-id', async () => {
      const res = await fetch(`${addr.url}/users/42?name=Forge`);
      assertEqual(res.status, 200, 'status');
      assertCondition(res.headers.get('x-request-id'), 'x-request-id present');
      const data = (await res.json()) as {
        id: string;
        greeting: string;
        remoteAddress: string | null;
      };
      assertEqual(data.id, '42', 'param id');
      assertEqual(data.greeting, 'Hi Forge', 'DI greeting');
      assertCondition(
        typeof data.remoteAddress === 'string' && data.remoteAddress.length > 0,
        'remoteAddress populated',
      );
    });

    await runCase('POST JSON 201, 404, RFC 405 Allow, HEAD body stripping, and 204', async () => {
      const postRes = await fetch(`${addr.url}/echo`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message: 'hello-wire' }),
      });
      assertEqual(postRes.status, 201, 'POST status');
      assertEqual(((await postRes.json()) as { echoed: string }).echoed, 'hello-wire', 'echoed');

      const notFound = await fetch(`${addr.url}/no-such-route`);
      assertEqual(notFound.status, 404, '404 status');
      await notFound.text();

      const methodNotAllowed = await fetch(`${addr.url}/echo`, { method: 'PUT' });
      assertEqual(methodNotAllowed.status, 405, '405 status');
      assertCondition(
        (methodNotAllowed.headers.get('allow') ?? '').includes('POST'),
        'Allow header includes POST',
      );
      await methodNotAllowed.text();

      const headRes = await fetch(`${addr.url}/users/42`, { method: 'HEAD' });
      assertEqual(headRes.status, 200, 'HEAD status');
      assertCondition(
        (headRes.headers.get('content-type') ?? '').includes('application/json'),
        'HEAD preserves content-type',
      );
      assertEqual(await headRes.text(), '', 'HEAD strips body');

      const delRes = await fetch(`${addr.url}/items/1`, { method: 'DELETE' });
      assertEqual(delRes.status, 204, '204 status');
      assertEqual(await delRes.text(), '', '204 empty body');
    });

    await runCase('Preserves multiple Set-Cookie headers across the HTTP wire', async () => {
      const res = await fetch(`${addr.url}/cookies`);
      assertEqual(res.status, 200, 'cookies status');
      const cookies = res.headers.getSetCookie();
      assertEqual(cookies.length, 2, 'Set-Cookie count');
      assertEqual(cookies[0], 'a=1; HttpOnly; Path=/', 'first cookie');
      assertEqual(cookies[1], 'b=2; HttpOnly; Path=/', 'second cookie');
      await res.text();
    });

    await runCase('Enforces bounded body size with 413 Payload Too Large', async () => {
      const oversized = JSON.stringify({ message: 'x'.repeat(500) });
      const res = await fetch(`${addr.url}/echo`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: oversized,
      });
      assertEqual(res.status, 413, 'oversized status');
      await res.text();
    });

    await runCase('Streams chunked responses and Server-Sent Events (SSE)', async () => {
      const streamRes = await fetch(`${addr.url}/stream`);
      assertEqual(streamRes.status, 200, 'stream status');
      assertEqual(await streamRes.text(), 'chunk-1|chunk-2', 'stream body');

      const sseRes = await fetch(`${addr.url}/sse`);
      assertEqual(sseRes.status, 200, 'sse status');
      assertEqual(
        sseRes.headers.get('content-type'),
        'text/event-stream; charset=utf-8',
        'sse content-type',
      );
      const sseText = await sseRes.text();
      assertCondition(sseText.includes('event: tick'), 'sse event');
      assertCondition(sseText.includes('data: {"n":2}'), 'sse second frame');
    });

    await runCase('Handles multipart/form-data file uploads over HTTP', async () => {
      const form = new FormData();
      form.append('label', 'wire-upload');
      form.append('file', new File(['forge-payload'], 'hello.txt', { type: 'text/plain' }));

      const res = await fetch(`${addr.url}/upload`, {
        method: 'POST',
        body: form,
      });
      assertEqual(res.status, 200, 'upload status');
      const data = (await res.json()) as {
        label: string | null;
        fileName: string | null;
        content: string | null;
      };
      assertEqual(data.label, 'wire-upload', 'multipart field');
      assertEqual(data.fileName, 'hello.txt', 'multipart filename');
      assertEqual(data.content, 'forge-payload', 'multipart file text');
    });

    await runCase('Propagates client abort to server request AbortSignal', async () => {
      const controller = new AbortController();
      const res = await fetch(`${addr.url}/abort-watch`, { signal: controller.signal });
      const reader = res.body?.getReader();
      assertCondition(reader, 'readable body');
      const firstChunk = await reader.read();
      assertCondition(!firstChunk.done, 'received initial chunk');

      controller.abort();
      try {
        await reader.cancel();
      } catch {
        // ignore abort cancellation error
      }

      const deadline = Date.now() + 1500;
      while (!abortObserved && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 20));
      }
      assertCondition(abortObserved, 'server observed client abort');
    });

    await runCase('Gracefully drains in-flight requests on app.close()', async () => {
      const started = new Promise<void>((resolve) => {
        slowRequestStarted = resolve;
      });
      const inFlightPromise = fetch(`${addr.url}/slow`);
      await started;

      const closePromise = app.close(2000);
      await new Promise((r) => setTimeout(r, 30));
      releaseSlowRequest?.();

      const res = await inFlightPromise;
      assertEqual(res.status, 200, 'in-flight request completed');
      const data = (await res.json()) as { drained: boolean };
      assertEqual(data.drained, true, 'drained payload');
      await closePromise;
    });
  } finally {
    await app.dispose();
  }

  return results;
}
