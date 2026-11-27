import {
  createHttpApp,
  type HttpRuntimeAdapter,
  type RegisteredWebSocketRoute,
  type WebSocketCloseInfo,
  type WebSocketConnection,
  type WebSocketMessageData,
  type WebSocketUpgradeContext,
} from '@forge-fr/http';

export interface MemoryWebSocketClient {
  send(data: WebSocketMessageData): void;
  close(code?: number, reason?: string): void;
  onMessage(listener: (data: WebSocketMessageData) => void): () => void;
  onClose(listener: (info: WebSocketCloseInfo) => void): () => void;
}

export interface MemoryWebSocketPair {
  readonly client: MemoryWebSocketClient;
  attachServer(route: RegisteredWebSocketRoute, ctx: WebSocketUpgradeContext): WebSocketConnection;
}

export function createMemoryWebSocketPair(): MemoryWebSocketPair {
  const clientMsgListeners = new Set<(data: WebSocketMessageData) => void>();
  const clientCloseListeners = new Set<(info: WebSocketCloseInfo) => void>();

  let attachedRoute: RegisteredWebSocketRoute | undefined;
  let attachedConn: WebSocketConnection | undefined;
  let readyState: 'open' | 'closing' | 'closed' = 'open';

  const client: MemoryWebSocketClient = {
    send(data: WebSocketMessageData): void {
      if (readyState !== 'open' || !attachedRoute || !attachedConn) {
        return;
      }
      const byteSize =
        typeof data === 'string'
          ? new TextEncoder().encode(data).byteLength
          : data.byteLength;
      if (byteSize > attachedRoute.maxPayloadBytes) {
        attachedConn.close(1009, 'Message Too Big');
        return;
      }
      void Promise.resolve(attachedRoute.handlers.onMessage?.(attachedConn, data)).catch((err: unknown) => {
        void attachedRoute?.handlers.onError?.(attachedConn!, err);
      });
    },
    close(code = 1000, reason = ''): void {
      if (readyState === 'closed') return;
      readyState = 'closed';
      const info: WebSocketCloseInfo = { code, reason, wasClean: code === 1000 };
      for (const listener of clientCloseListeners) {
        listener(info);
      }
      if (attachedRoute && attachedConn) {
        void Promise.resolve(attachedRoute.handlers.onClose?.(attachedConn, info)).catch(() => {});
      }
    },
    onMessage(listener) {
      clientMsgListeners.add(listener);
      return () => clientMsgListeners.delete(listener);
    },
    onClose(listener) {
      clientCloseListeners.add(listener);
      return () => clientCloseListeners.delete(listener);
    },
  };

  return {
    client,
    attachServer(route: RegisteredWebSocketRoute, ctx: WebSocketUpgradeContext): WebSocketConnection {
      attachedRoute = route;
      const conn: WebSocketConnection = {
        id: 'mem-ws-1',
        url: ctx.url,
        headers: ctx.headers,
        params: ctx.params,
        protocol: ctx.protocol,
        get readyState() {
          return readyState;
        },
        send(data: WebSocketMessageData): void {
          if (readyState !== 'open') return;
          for (const listener of clientMsgListeners) {
            listener(data);
          }
        },
        close(code = 1000, reason = ''): void {
          if (readyState === 'closed') return;
          readyState = 'closed';
          const info: WebSocketCloseInfo = { code, reason, wasClean: code === 1000 };
          for (const listener of clientCloseListeners) {
            listener(info);
          }
          void Promise.resolve(route.handlers.onClose?.(conn, info)).catch(() => {});
        },
        ping(): void {
          // No-op in memory pair
        },
        getState<T = unknown>(key: string): T | undefined {
          return ctx.state.get(key) as T | undefined;
        },
        setState<T = unknown>(key: string, value: T): void {
          ctx.state.set(key, value);
        },
      };
      attachedConn = conn;
      void Promise.resolve(route.handlers.onOpen?.(conn, ctx)).catch((err: unknown) => {
        void route.handlers.onError?.(conn, err);
        conn.close(1011, 'Internal server error');
      });
      return conn;
    },
  };
}

/**
 * Shared live WebSocket contract test suite executed identically over real loopback TCP sockets
 * on both NodeAdapter and BunAdapter using the runtime's standard global WebSocket client.
 */
export async function runWebSocketContractSuite(
  createAdapter: () => HttpRuntimeAdapter,
): Promise<void> {
  const adapter = createAdapter();
  const app = createHttpApp({ adapter });

  app.ws(
    '/ws/echo/:channel',
    {
      authenticate(ctx) {
        return ctx.query['token'] === 'ws-secret';
      },
      onOpen(ws) {
        ws.send(`joined:${ws.params['channel']}`);
      },
      onMessage(ws, message) {
        if (typeof message === 'string') {
          ws.send(`echo:${message}`);
        } else {
          ws.send(message);
        }
      },
    },
    { maxPayloadBytes: 64 },
  );

  const addr = await app.listen({ host: '127.0.0.1', port: 0 });
  const wsBase = addr.url.replace(/^http:/, 'ws:');

  try {
    // 1. Pre-upgrade auth failure rejects connection cleanly before 101
    await new Promise<void>((resolve, reject) => {
      const badWs = new globalThis.WebSocket(`${wsBase}/ws/echo/general?token=invalid`);
      let opened = false;
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          reject(new Error('Timed out waiting for rejected WebSocket handshake'));
        }
      }, 2000);

      const finishRejected = (): void => {
        if (settled || opened) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolve();
      };

      badWs.onopen = () => {
        opened = true;
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          badWs.close();
          reject(new Error('Expected unauthenticated WebSocket upgrade to fail before opening'));
        }
      };
      badWs.onerror = finishRejected;
      badWs.onclose = finishRejected;
    });

    // 2. Valid text + binary loopback echo
    await new Promise<void>((resolve, reject) => {
      const ws = new globalThis.WebSocket(`${wsBase}/ws/echo/alpha?token=ws-secret`);
      ws.binaryType = 'arraybuffer';
      const received: Array<string | ArrayBuffer> = [];

      ws.onerror = (err) => reject(new Error(`WebSocket error: ${String(err)}`));
      ws.onmessage = (ev) => {
        received.push(ev.data as string | ArrayBuffer);
        if (received.length === 1) {
          if (ev.data !== 'joined:alpha') {
            reject(new Error(`Expected joined:alpha, got ${String(ev.data)}`));
            return;
          }
          ws.send('hello-ws');
        } else if (received.length === 2) {
          if (ev.data !== 'echo:hello-ws') {
            reject(new Error(`Expected echo:hello-ws, got ${String(ev.data)}`));
            return;
          }
          ws.send(new Uint8Array([1, 2, 3, 4]));
        } else if (received.length === 3) {
          const bytes = new Uint8Array(ev.data as ArrayBuffer);
          if (bytes.length !== 4 || bytes[0] !== 1 || bytes[3] !== 4) {
            reject(new Error('Expected binary echo [1,2,3,4]'));
            return;
          }
          ws.close(1000, 'done');
        }
      };
      ws.onclose = () => {
        if (received.length === 3) {
          resolve();
        }
      };
    });

    // 3. Oversized frame enforcement (maxPayloadBytes = 64 -> close code 1009)
    await new Promise<void>((resolve, reject) => {
      const ws = new globalThis.WebSocket(`${wsBase}/ws/echo/limit?token=ws-secret`);
      let stage = 0;
      ws.onmessage = () => {
        if (stage === 0) {
          stage = 1;
          ws.send('A'.repeat(200));
        }
      };
      ws.onclose = (ev) => {
        if (ev.code === 1009) {
          resolve();
        } else {
          reject(new Error(`Expected close code 1009 for oversized frame, got ${ev.code}`));
        }
      };
    });
  } finally {
    await app.close(2000);
  }
}
