import {
  ForgeHttpError,
  type FetchHandler,
  type HttpRuntimeAdapter,
  type ListenOptions,
  type RegisteredWebSocketRoute,
  type ServerAddress,
  type WebSocketConnection,
  type WebSocketMessageData,
  type WebSocketUpgradeContext,
} from '@forge-fr/http';

const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5_000;
const MAX_BUN_IDLE_TIMEOUT_SECONDS = 255;

export interface BunSocketAddressLike {
  readonly address: string;
  readonly family: string;
  readonly port: number;
}

export interface BunServerWebSocketData {
  readonly route: RegisteredWebSocketRoute;
  readonly upgradeContext: WebSocketUpgradeContext;
  conn?: WebSocketConnection;
  readyState: 'open' | 'closing' | 'closed';
}

export interface BunServerWebSocketLike {
  readonly data: BunServerWebSocketData;
  readonly remoteAddress?: string;
  send(data: string | ArrayBuffer | Uint8Array, compress?: boolean): number;
  close(code?: number, reason?: string): void;
  ping?(data?: string | Uint8Array): void;
}

export interface BunWebSocketHandlerLike {
  readonly maxPayloadLength?: number;
  readonly open?: (ws: BunServerWebSocketLike) => void | Promise<void>;
  readonly message?: (
    ws: BunServerWebSocketLike,
    message: string | Uint8Array,
  ) => void | Promise<void>;
  readonly close?: (
    ws: BunServerWebSocketLike,
    code: number,
    reason: string,
  ) => void | Promise<void>;
  readonly pong?: (ws: BunServerWebSocketLike, data: Uint8Array) => void | Promise<void>;
}

export interface BunServerLike {
  readonly hostname?: string;
  readonly port?: number;
  readonly url?: URL;
  requestIP?(request: Request): BunSocketAddressLike | null;
  upgrade?(
    request: Request,
    options?: {
      readonly data?: unknown;
      readonly headers?: HeadersInit;
    },
  ): boolean;
  stop(closeActiveConnections?: boolean): Promise<void> | void;
}

export interface BunServeOptionsLike {
  readonly hostname?: string;
  readonly port: number;
  readonly maxRequestBodySize?: number;
  readonly idleTimeout?: number;
  readonly development?: boolean;
  readonly websocket?: BunWebSocketHandlerLike;
  readonly fetch: (request: Request, server: BunServerLike) => Promise<Response> | Response;
  readonly error?: (error: Error) => Promise<Response> | Response;
}

export type BunServeLike = (options: BunServeOptionsLike) => BunServerLike;

export interface BunAdapterOptions {
  /** Optional custom serve implementation (primarily for unit testing). Defaults to globalThis.Bun.serve. */
  readonly serve?: BunServeLike;
  readonly development?: boolean;
}

function resolveBunServe(customServe?: BunServeLike): BunServeLike {
  if (customServe) {
    return customServe;
  }

  const candidate = (
    globalThis as unknown as {
      readonly Bun?: { readonly serve?: BunServeLike };
    }
  ).Bun?.serve;

  if (typeof candidate !== 'function') {
    throw new ForgeHttpError(
      'BunAdapter requires the Bun runtime (globalThis.Bun.serve was not found). Use @forge-fr/node on Node.js.',
      {
        code: 'BUN_RUNTIME_REQUIRED',
        statusCode: 500,
        expose: false,
      },
    );
  }

  return candidate;
}

function createBunWsConnection(ws: BunServerWebSocketLike): WebSocketConnection {
  const { upgradeContext } = ws.data;
  const connState = upgradeContext.state;

  return {
    id: globalThis.crypto.randomUUID(),
    url: upgradeContext.url,
    headers: upgradeContext.headers,
    params: upgradeContext.params,
    ...(upgradeContext.remoteAddress !== undefined
      ? { remoteAddress: upgradeContext.remoteAddress }
      : {}),
    protocol: upgradeContext.protocol,
    get readyState() {
      return ws.data.readyState;
    },
    send(data: WebSocketMessageData): void {
      if (ws.data.readyState !== 'open') {
        return;
      }
      ws.send(data);
    },
    close(code = 1000, reason = ''): void {
      if (ws.data.readyState === 'closed' || ws.data.readyState === 'closing') {
        return;
      }
      ws.data.readyState = 'closing';
      ws.close(code, reason);
    },
    ping(data?: WebSocketMessageData): void {
      if (ws.data.readyState !== 'open' || typeof ws.ping !== 'function') {
        return;
      }
      ws.ping(data);
    },
    getState<T = unknown>(key: string): T | undefined {
      return connState.get(key) as T | undefined;
    },
    setState<T = unknown>(key: string, value: T): void {
      connState.set(key, value);
    },
  };
}

export class BunAdapter implements HttpRuntimeAdapter {
  public readonly name = 'bun';
  public readonly runtime = 'bun' as const;

  private readonly customServe?: BunServeLike;
  private readonly development: boolean;

  private server: BunServerLike | null = null;
  private activeAddress: ServerAddress | null = null;
  private inFlightCount = 0;
  private onDrained: (() => void) | null = null;
  private readonly activeWebSockets = new Set<BunServerWebSocketLike>();
  private closing = false;
  private shutdownAbortCleanup: (() => void) | null = null;

  public constructor(options: BunAdapterOptions = {}) {
    if (options.serve !== undefined) {
      this.customServe = options.serve;
    }
    this.development = options.development ?? false;
  }

  public get isListening(): boolean {
    return this.server !== null && !this.closing;
  }

  public get address(): ServerAddress | null {
    return this.activeAddress;
  }

  public async listen(handler: FetchHandler, options: ListenOptions): Promise<ServerAddress> {
    if (this.server !== null) {
      throw new ForgeHttpError('BunAdapter is already listening', {
        code: 'ADAPTER_ALREADY_LISTENING',
        statusCode: 500,
        expose: false,
      });
    }

    const serveFn = resolveBunServe(this.customServe);
    const bindHost = options.host ?? '127.0.0.1';
    const defaultShutdownTimeout = options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
    this.closing = false;

    const enableWebSocket =
      (handler as { hasWebSocketRoutes?: boolean }).hasWebSocketRoutes !== false &&
      typeof handler.authorizeWebSocketUpgrade === 'function';

    const serveOptions: BunServeOptionsLike = {
      hostname: bindHost,
      port: options.port,
      development: this.development,
      ...(options.maxBodyBytes !== undefined
        ? { maxRequestBodySize: options.maxBodyBytes }
        : {}),
      ...(options.requestTimeoutMs !== undefined
        ? {
            idleTimeout: Math.min(
              MAX_BUN_IDLE_TIMEOUT_SECONDS,
              Math.max(1, Math.ceil(options.requestTimeoutMs / 1000)),
            ),
          }
        : {}),
      ...(enableWebSocket
        ? {
            websocket: {
              maxPayloadLength: 16 * 1024 * 1024,
              open: (bunWs) => {
                this.activeWebSockets.add(bunWs);
                const conn = createBunWsConnection(bunWs);
                bunWs.data.conn = conn;
                void Promise.resolve(
                  bunWs.data.route.handlers.onOpen?.(conn, bunWs.data.upgradeContext),
                ).catch((err: unknown) => {
                  void bunWs.data.route.handlers.onError?.(conn, err);
                  conn.close(1011, 'Internal server error');
                });
              },
              message: (bunWs, rawMessage) => {
                const conn = bunWs.data.conn;
                if (!conn) return;
                const byteSize =
                  typeof rawMessage === 'string'
                    ? new TextEncoder().encode(rawMessage).byteLength
                    : rawMessage.byteLength;
                if (byteSize > bunWs.data.route.maxPayloadBytes) {
                  conn.close(1009, 'Message Too Big');
                  return;
                }
                const payload: WebSocketMessageData =
                  typeof rawMessage === 'string' ? rawMessage : new Uint8Array(rawMessage);
                void Promise.resolve(
                  bunWs.data.route.handlers.onMessage?.(conn, payload),
                ).catch((err: unknown) => {
                  void bunWs.data.route.handlers.onError?.(conn, err);
                });
              },
              close: (bunWs, code, reason) => {
                this.activeWebSockets.delete(bunWs);
                bunWs.data.readyState = 'closed';
                const conn = bunWs.data.conn;
                if (!conn) return;
                void Promise.resolve(
                  bunWs.data.route.handlers.onClose?.(conn, {
                    code,
                    reason,
                    wasClean: code === 1000,
                  }),
                ).catch(() => {});
              },
              pong: (bunWs, data) => {
                const conn = bunWs.data.conn;
                if (!conn) return;
                void Promise.resolve(
                  bunWs.data.route.handlers.onPong?.(conn, new Uint8Array(data)),
                ).catch(() => {});
              },
            },
          }
        : {}),
      fetch: enableWebSocket
        ? (request: Request, srv: BunServerLike): Promise<Response> | Response => {
              if (
                typeof srv.upgrade === 'function' &&
                request.headers.get('upgrade')?.toLowerCase() === 'websocket'
              ) {
                this.inFlightCount += 1;
                return (async (): Promise<Response> => {
                  const ip =
                    typeof srv.requestIP === 'function'
                      ? srv.requestIP(request)?.address
                      : undefined;
                  const decision = await handler.authorizeWebSocketUpgrade!(request, {
                    runtime: 'bun',
                    ...(ip !== undefined ? { remoteAddress: ip } : {}),
                  });
                  if (!decision.accepted) {
                    return decision.response;
                  }
                  const upgraded = srv.upgrade!(request, {
                    data: {
                      route: decision.route,
                      upgradeContext: decision.upgradeContext,
                      readyState: 'open',
                    } satisfies BunServerWebSocketData,
                    ...(decision.upgradeContext.protocol
                      ? { headers: { 'sec-websocket-protocol': decision.upgradeContext.protocol } }
                      : {}),
                  });
                  if (upgraded) {
                    return undefined as unknown as Response;
                  }
                  return new Response('WebSocket upgrade failed', { status: 400 });
                })()
                  .catch(() => {
                    return new Response(
                      JSON.stringify({
                        error: {
                          code: 'INTERNAL_ERROR',
                          message: 'Internal Server Error',
                        },
                      }),
                      {
                        status: 500,
                        headers: { 'content-type': 'application/json; charset=utf-8' },
                      },
                    );
                  })
                  .finally(() => {
                    this.decrementInFlight();
                  });
              }

              return this.dispatchBunHttp(handler, request, srv);
            }
          : typeof handler.authorizeWebSocketUpgrade === 'function'
            ? (request: Request, srv: BunServerLike): Promise<Response> | Response => {
                let meta = this.cachedMeta;
                if (this.cachedSrv !== srv || meta === null) {
                  this.cachedSrv = srv;
                  meta =
                    typeof srv.requestIP === 'function'
                      ? {
                          runtime: 'bun',
                          requestIP: (req: Request) => srv.requestIP!(req),
                        }
                      : { runtime: 'bun' };
                  this.cachedMeta = meta;
                }
                const resOrPromise = handler(request, meta);
                if (!(resOrPromise instanceof Promise)) {
                  return resOrPromise;
                }
                return this.trackAsyncBunResponse(resOrPromise);
              }
            : (request: Request, srv: BunServerLike): Promise<Response> | Response => {
                return this.dispatchBunHttp(handler, request, srv);
              },
      error: () =>
        new Response(
          JSON.stringify({
            error: {
              code: 'INTERNAL_ERROR',
              message: 'Internal Server Error',
            },
          }),
          {
            status: 500,
            headers: { 'content-type': 'application/json; charset=utf-8' },
          },
        ),
    };

    const server = serveFn(serveOptions);
    const boundHost = server.hostname ?? bindHost;
    const boundPort = server.port ?? options.port;
    const formattedHost = boundHost.includes(':') ? `[${boundHost}]` : boundHost;

    this.server = server;
    this.activeAddress = {
      host: boundHost,
      port: boundPort,
      protocol: 'http',
      url: `http://${formattedHost}:${boundPort}`,
    };

    if (options.signal) {
      const onSignalAbort = (): void => {
        void this.close(defaultShutdownTimeout);
      };
      if (options.signal.aborted) {
        void this.close(defaultShutdownTimeout);
      } else {
        options.signal.addEventListener('abort', onSignalAbort, { once: true });
        this.shutdownAbortCleanup = () => {
          options.signal?.removeEventListener('abort', onSignalAbort);
        };
      }
    }

    return this.activeAddress;
  }

  private decrementInFlight(): void {
    this.inFlightCount -= 1;
    if (this.closing && this.inFlightCount === 0 && this.onDrained !== null) {
      this.onDrained();
      this.onDrained = null;
    }
  }

  private cachedSrv: BunServerLike | null = null;
  private cachedMeta: {
    readonly runtime: 'bun';
    readonly requestIP?: (req: Request) => { readonly address?: string } | null;
  } | null = null;

  private trackAsyncBunResponse(resPromise: Promise<Response>): Promise<Response> {
    this.inFlightCount += 1;
    return resPromise.then(
      (res) => {
        this.decrementInFlight();
        return res;
      },
      () => {
        this.decrementInFlight();
        return new Response(
          JSON.stringify({
            error: {
              code: 'INTERNAL_ERROR',
              message: 'Internal Server Error',
            },
          }),
          {
            status: 500,
            headers: { 'content-type': 'application/json; charset=utf-8' },
          },
        );
      },
    );
  }

  private dispatchBunHttp(
    handler: FetchHandler,
    request: Request,
    srv: BunServerLike,
  ): Promise<Response> | Response {
    let meta: {
      readonly runtime: 'bun';
      readonly remoteAddress?: string | undefined;
      readonly requestIP?: (req: Request) => { readonly address?: string } | null;
    };

    if (typeof handler.authorizeWebSocketUpgrade === 'function') {
      let cached = this.cachedMeta;
      if (this.cachedSrv !== srv || cached === null) {
        this.cachedSrv = srv;
        cached =
          typeof srv.requestIP === 'function'
            ? {
                runtime: 'bun',
                requestIP: (req: Request) => srv.requestIP!(req),
              }
            : { runtime: 'bun' };
        this.cachedMeta = cached;
      }
      meta = cached;
    } else {
      meta = {
        runtime: 'bun',
        get remoteAddress(): string | undefined {
          return typeof srv.requestIP === 'function'
            ? srv.requestIP(request)?.address
            : undefined;
        },
      };
    }

    try {
      const resOrPromise = handler(request, meta);

      if (!(resOrPromise instanceof Promise)) {
        return resOrPromise;
      }

      return this.trackAsyncBunResponse(resOrPromise);
    } catch {
      return new Response(
        JSON.stringify({
          error: {
            code: 'INTERNAL_ERROR',
            message: 'Internal Server Error',
          },
        }),
        {
          status: 500,
          headers: { 'content-type': 'application/json; charset=utf-8' },
        },
      );
    }
  }

  public async close(timeoutMs = DEFAULT_SHUTDOWN_TIMEOUT_MS): Promise<void> {
    if (this.shutdownAbortCleanup) {
      this.shutdownAbortCleanup();
      this.shutdownAbortCleanup = null;
    }

    const server = this.server;
    if (!server) {
      return;
    }

    this.closing = true;
    this.server = null;
    this.activeAddress = null;

    for (const bunWs of Array.from(this.activeWebSockets)) {
      bunWs.data.readyState = 'closing';
      try {
        bunWs.close(1001, 'Server shutting down');
      } catch {
        // Ignore
      }
    }

    let timer: ReturnType<typeof setTimeout> | undefined;
    const drainPromise =
      this.inFlightCount === 0
        ? Promise.resolve()
        : new Promise<void>((resolve) => {
            this.onDrained = resolve;
            if (this.inFlightCount === 0) {
              resolve();
              this.onDrained = null;
            }
          });
    const gracefulStop = drainPromise.then(() => Promise.resolve(server.stop(false)));

    const forceOnTimeout = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        Promise.resolve(server.stop(true))
          .catch(() => {})
          .finally(resolve);
      }, Math.max(0, timeoutMs));
    });

    await Promise.race([gracefulStop, forceOnTimeout]);
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    this.closing = false;
  }
}

export function createBunAdapter(options?: BunAdapterOptions): BunAdapter {
  return new BunAdapter(options);
}
