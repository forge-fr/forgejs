import { createHttpApp } from '@forge-fr/http';
import { describe, expect, it } from 'vitest';
import {
  EdgeAdapter,
  createCloudflareWorkerHandler,
  createDenoHandler,
  createEdgeAdapter,
  createEdgeHandler,
  getEdgeEnv,
  getEdgeExecutionContext,
  runInEdgeBackground,
} from '../src/index.js';

describe('@forge-fr/edge WinterCG, Cloudflare Workers & Deno Handlers', () => {
  it('auto-boots a ForgeHttpApp once and tracks env, executionContext, and waitUntil tasks safely', async () => {
    const app = createHttpApp({ adapter: createEdgeAdapter({ runtime: 'cloudflare-workers' }) });
    let bootCount = 0;
    app.kernel.hooks.add(
      'start',
      () => {
        bootCount += 1;
      },
      { id: 'boot-counter' },
    );

    app.get('/edge', async (ctx) => {
      const env = getEdgeEnv<{ readonly ENV_NAME: string }>(ctx.request);
      const execCtx = getEdgeExecutionContext(ctx.request);
      runInEdgeBackground(ctx.request, Promise.resolve('bg-done'));
      return ctx.json({
        runtime: ctx.runtime,
        ip: ctx.remoteAddress,
        envName: env?.ENV_NAME,
        hasExecCtx: execCtx !== undefined,
      });
    });

    const worker = createCloudflareWorkerHandler<{ readonly ENV_NAME: string }>(app, {
      trustCfConnectingIp: true,
    });

    const waited: Promise<unknown>[] = [];
    const execCtx = {
      waitUntil(promise: Promise<unknown>) {
        waited.push(promise);
      },
    };

    const res = await worker.fetch(
      new Request('https://worker.example.com/edge', {
        headers: { 'cf-connecting-ip': '203.0.113.10' },
      }),
      { ENV_NAME: 'production' },
      execCtx,
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      runtime: 'cloudflare-workers',
      ip: '203.0.113.10',
      envName: 'production',
      hasExecCtx: true,
    });
    expect(waited).toHaveLength(1);
    await Promise.all(waited);

    await worker.fetch(new Request('https://worker.example.com/edge'), { ENV_NAME: 'production' });
    expect(bootCount).toBe(1);
    await app.dispose();
  });

  it('serves Deno handler with remoteAddr mapping and rejects TCP listen() cleanly on EdgeAdapter', async () => {
    const app = createHttpApp();
    app.get('/deno', (ctx) => ctx.json({ runtime: ctx.runtime, ip: ctx.remoteAddress }));

    const denoFetch = createDenoHandler(app);
    const res = await denoFetch(new Request('https://deno.example.com/deno'), {
      remoteAddr: { hostname: '198.51.100.7', port: 51234 },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      runtime: 'deno',
      ip: '198.51.100.7',
    });

    const edgeAdapter = new EdgeAdapter();
    await expect(edgeAdapter.listen(app.fetch, { port: 3000 })).rejects.toThrow(
      /serverless Fetch isolates/i,
    );

    const genericFetch = createEdgeHandler(app.fetch);
    const directRes = await genericFetch(new Request('https://edge.example.com/deno'));
    expect(directRes.status).toBe(200);

    await app.dispose();
  });

  it('upgrades authorized WebSocket connections on Cloudflare Workers and Deno handlers while enforcing Origin guards', async () => {
    const app = createHttpApp();
    app.ws(
      '/ws/edge',
      {
        onOpen(ws) {
          ws.send(`connected:${ws.url.pathname}`);
        },
        onMessage(ws, msg) {
          ws.send(`edge:${String(msg)}`);
        },
      },
      { allowedOrigins: ['https://app.example.com'] },
    );

    const serverEvents = new Map<string, Array<(ev: unknown) => void>>();
    const sentMessages: Array<string | ArrayBuffer | Uint8Array> = [];
    const clientToken = { role: 'client-socket' };
    const serverSocket = {
      accepted: false,
      accept() {
        this.accepted = true;
      },
      send(data: string | ArrayBuffer | Uint8Array) {
        sentMessages.push(data);
      },
      close() {},
      addEventListener(type: string, listener: (ev: unknown) => void) {
        const list = serverEvents.get(type) ?? [];
        list.push(listener);
        serverEvents.set(type, list);
      },
    };

    class MockWebSocketPair {
      readonly 0 = clientToken;
      readonly 1 = serverSocket;
    }

    const worker = createCloudflareWorkerHandler(app, {
      webSocketPair: MockWebSocketPair,
    });

    const rejected = await worker.fetch(
      new Request('https://edge.example.com/ws/edge', {
        headers: {
          upgrade: 'websocket',
          origin: 'https://evil.example',
        },
      }),
    );
    expect(rejected.status).toBe(403);

    const upgraded = await worker.fetch(
      new Request('https://edge.example.com/ws/edge', {
        headers: {
          upgrade: 'websocket',
          origin: 'https://app.example.com',
        },
      }),
    );
    expect(upgraded.status).toBe(101);
    expect(serverSocket.accepted).toBe(true);
    for (const listener of serverEvents.get('message') ?? []) {
      listener({ data: 'ping-worker' });
    }
    expect(sentMessages).toEqual(['connected:/ws/edge', 'edge:ping-worker']);

    // Verify Deno.upgradeWebSocket path
    const denoSent: Array<string | ArrayBuffer | Uint8Array> = [];
    let denoOnOpen: ((ev: unknown) => void) | null = null;
    let denoOnMsg: ((ev: { data: string | ArrayBuffer | Uint8Array }) => void) | null = null;

    const denoHandler = createDenoHandler(app, {
      upgradeWebSocket: () => ({
        response: Object.defineProperty(new Response(null, { status: 200 }), 'status', {
          value: 101,
        }),
        socket: {
          send(data) {
            denoSent.push(data);
          },
          close() {},
          set onopen(fn: ((ev: unknown) => void) | null) {
            denoOnOpen = fn;
          },
          set onmessage(fn: ((ev: { data: string | ArrayBuffer | Uint8Array }) => void) | null) {
            denoOnMsg = fn;
          },
          onclose: null,
          onerror: null,
        },
      }),
    });

    const denoRes = await denoHandler(
      new Request('https://deno.example.com/ws/edge', {
        headers: {
          upgrade: 'websocket',
          origin: 'https://app.example.com',
        },
      }),
    );
    expect(denoRes.status).toBe(101);
    (denoOnOpen as ((ev: unknown) => void) | null)?.({});
    (denoOnMsg as ((ev: { data: string }) => void) | null)?.({ data: 'ping-deno' });
    expect(denoSent).toEqual(['connected:/ws/edge', 'edge:ping-deno']);

    await app.dispose();
  });
});
