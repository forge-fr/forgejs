import { ForgeHttpError } from '@forge-fr/http';
import { describe, expect, it } from 'vitest';
import { BunAdapter, createBunAdapter, type BunServerLike, type BunServeLike } from '../src/index.js';

describe('@forge-fr/bun — Native Bun HTTP Adapter', () => {
  it('fails explicitly with BUN_RUNTIME_REQUIRED when listen() is called outside Bun', async () => {
    const adapter = createBunAdapter();
    await expect(
      adapter.listen(() => new Response('ok'), { port: 0 }),
    ).rejects.toMatchObject({
      code: 'BUN_RUNTIME_REQUIRED',
    });
  });

  it('wires Bun.serve options, requestIP remoteAddress, AbortSignal shutdown, and graceful stop(false)', async () => {
    let capturedFetch: ((req: Request, server: BunServerLike) => Promise<Response> | Response) | null =
      null;
    let capturedOptions: Record<string, unknown> | null = null;
    const stopCalls: boolean[] = [];

    const fakeServer: BunServerLike = {
      hostname: '127.0.0.1',
      port: 43210,
      url: new URL('http://127.0.0.1:43210/'),
      requestIP() {
        return { address: '127.0.0.1', family: 'IPv4', port: 55000 };
      },
      async stop(closeActiveConnections = false) {
        stopCalls.push(closeActiveConnections);
      },
    };

    const fakeServe: BunServeLike = (options) => {
      capturedOptions = options as unknown as Record<string, unknown>;
      capturedFetch = options.fetch;
      return fakeServer;
    };

    const adapter = new BunAdapter({ serve: fakeServe });
    const shutdownController = new AbortController();

    const addr = await adapter.listen(
      (req, meta) =>
        Response.json({
          path: new URL(req.url).pathname,
          ip: meta?.remoteAddress ?? null,
          runtime: meta?.runtime ?? null,
        }),
      {
        host: '127.0.0.1',
        port: 0,
        maxBodyBytes: 2048,
        requestTimeoutMs: 15_000,
        signal: shutdownController.signal,
      },
    );

    expect(addr).toEqual({
      host: '127.0.0.1',
      port: 43210,
      protocol: 'http',
      url: 'http://127.0.0.1:43210',
    });
    expect(capturedOptions?.maxRequestBodySize).toBe(2048);
    expect(capturedOptions?.idleTimeout).toBe(15);

    expect(capturedFetch).not.toBeNull();
    const response = await capturedFetch!(new Request('http://127.0.0.1:43210/ping'), fakeServer);
    expect(await response.json()).toEqual({
      path: '/ping',
      ip: '127.0.0.1',
      runtime: 'bun',
    });

    // Double listen must throw
    await expect(adapter.listen(() => new Response('x'), { port: 0 })).rejects.toBeInstanceOf(
      ForgeHttpError,
    );

    // AbortSignal triggers graceful stop(false)
    shutdownController.abort();
    await new Promise((r) => setTimeout(r, 20));
    expect(stopCalls).toEqual([false]);
    expect(adapter.isListening).toBe(false);
  });
});
