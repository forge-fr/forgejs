import {
  ForgeHttpError,
  type FetchHandler,
  type HttpRuntimeAdapter,
  type ListenOptions,
  type RuntimeRequestMeta,
  type ServerAddress,
} from '@forge-fr/http';

export interface EdgeExecutionContextLike {
  waitUntil?(promise: Promise<unknown>): void;
  passThroughOnException?(): void;
}

export interface EdgeAppTarget {
  readonly fetch: FetchHandler;
  readonly kernel?: { readonly state: string };
  start?(): Promise<void>;
}

export interface EdgeServerWebSocketLike {
  accept?(): void;
  send(data: string | ArrayBuffer | Uint8Array): void;
  close(code?: number, reason?: string): void;
  addEventListener?(
    type: 'open' | 'message' | 'close' | 'error',
    listener: (event: unknown) => void,
  ): void;
  onopen?: ((event: unknown) => void) | null;
  onmessage?: ((event: { readonly data: string | ArrayBuffer | Uint8Array }) => void) | null;
  onclose?: ((event: { readonly code?: number; readonly reason?: string; readonly wasClean?: boolean }) => void) | null;
  onerror?: ((event: unknown) => void) | null;
}

export interface EdgeWebSocketPairLike {
  readonly 0: unknown;
  readonly 1: EdgeServerWebSocketLike;
}

export type EdgeWebSocketPairConstructor = new () => EdgeWebSocketPairLike;

export type DenoUpgradeWebSocketFn = (
  request: Request,
  options?: { readonly protocol?: string },
) => { readonly response: Response; readonly socket: EdgeServerWebSocketLike };

export interface EdgeHandlerOptions<TEnv = unknown> {
  /** Runtime identifier exposed as `ctx.runtime`. Default: `'edge'`. */
  readonly runtime?: string;
  /** Automatically call `app.start()` once before serving the first request. Default: `true`. */
  readonly autoStart?: boolean;
  /** Optional resolver extracting client IP safely from edge platform metadata/request. */
  readonly resolveRemoteAddress?: (request: Request, env?: TEnv) => string | undefined;
  /** Optional Cloudflare Worker compatibility helper reading `cf-connecting-ip`. Default: `false`. */
  readonly trustCfConnectingIp?: boolean;
  /** Optional WebSocketPair constructor override (defaults to Cloudflare Workers global `WebSocketPair`). */
  readonly webSocketPair?: EdgeWebSocketPairConstructor;
}

export interface CloudflareWorkerHandlerOptions<TEnv = unknown>
  extends EdgeHandlerOptions<TEnv> {}

export interface DenoServeAddrLike {
  readonly hostname?: string;
  readonly port?: number;
  readonly transport?: string;
}

export interface DenoServeHandlerInfoLike {
  readonly remoteAddr?: DenoServeAddrLike;
}

export interface DenoHandlerOptions extends EdgeHandlerOptions<never> {
  /** Optional Deno.upgradeWebSocket override (defaults to `globalThis.Deno.upgradeWebSocket`). */
  readonly upgradeWebSocket?: DenoUpgradeWebSocketFn;
}

export interface CloudflareWorkerModule<TEnv = unknown> {
  fetch(
    request: Request,
    env?: TEnv,
    ctx?: EdgeExecutionContextLike,
  ): Promise<Response>;
}

const EDGE_ENV_MAP = new WeakMap<Request, unknown>();
const EDGE_CTX_MAP = new WeakMap<Request, EdgeExecutionContextLike>();

export function getEdgeEnv<TEnv = Record<string, unknown>>(request: Request): TEnv | undefined {
  return EDGE_ENV_MAP.get(request) as TEnv | undefined;
}

export function getEdgeExecutionContext(
  request: Request,
): EdgeExecutionContextLike | undefined {
  return EDGE_CTX_MAP.get(request);
}

export function runInEdgeBackground(request: Request, task: Promise<unknown>): void {
  const safeTask = task.catch(() => {});
  const ctx = EDGE_CTX_MAP.get(request);
  if (ctx && typeof ctx.waitUntil === 'function') {
    ctx.waitUntil(safeTask);
  }
}

function isFetchAppTarget(target: FetchHandler | EdgeAppTarget): target is EdgeAppTarget {
  return typeof target === 'object' && target !== null && 'fetch' in target;
}

function createBootStarter(
  target: FetchHandler | EdgeAppTarget,
  autoStart: boolean,
): () => Promise<void> {
  let bootPromise: Promise<void> | null = null;
  return async (): Promise<void> => {
    if (!autoStart || !isFetchAppTarget(target) || typeof target.start !== 'function') {
      return;
    }
    if (target.kernel?.state === 'ready') {
      return;
    }
    if (bootPromise === null) {
      bootPromise = target.start().catch((err: unknown) => {
        bootPromise = null;
        throw err;
      });
    }
    await bootPromise;
  };
}

function internalErrorResponse(): Response {
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

function unsupportedEdgeWsResponse(runtime: string): Response {
  return new Response(
    JSON.stringify({
      error: {
        code: 'EDGE_WEBSOCKET_UNSUPPORTED',
        message: `WebSocket upgrade is not supported in this ${runtime} isolate`,
      },
    }),
    {
      status: 501,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    },
  );
}

function normalizeEdgeWsPayload(data: string | ArrayBuffer | Uint8Array): string | Uint8Array {
  if (typeof data === 'string') {
    return data;
  }
  if (data instanceof Uint8Array) {
    return data;
  }
  return new Uint8Array(data);
}

function bindEdgeWebSocketLifecycle(
  socket: EdgeServerWebSocketLike,
  decision: Extract<
    Awaited<ReturnType<NonNullable<FetchHandler['authorizeWebSocketUpgrade']>>>,
    { readonly accepted: true }
  >,
  acceptImmediately: boolean,
): void {
  let readyState: 'open' | 'closing' | 'closed' = 'open';
  const { route, upgradeContext } = decision;
  const conn = {
    id: globalThis.crypto.randomUUID(),
    url: upgradeContext.url,
    headers: upgradeContext.headers,
    params: upgradeContext.params,
    ...(upgradeContext.remoteAddress !== undefined
      ? { remoteAddress: upgradeContext.remoteAddress }
      : {}),
    protocol: upgradeContext.protocol,
    get readyState() {
      return readyState;
    },
    send(data: string | Uint8Array): void {
      if (readyState !== 'open') return;
      socket.send(data);
    },
    close(code = 1000, reason = ''): void {
      if (readyState === 'closed' || readyState === 'closing') return;
      readyState = 'closing';
      socket.close(code, reason);
    },
    ping(): void {
      // Standard WinterCG/Cloudflare/Deno WebSocket objects manage ping/pong at runtime level
    },
    getState<T = unknown>(key: string): T | undefined {
      return upgradeContext.state.get(key) as T | undefined;
    },
    setState<T = unknown>(key: string, value: T): void {
      upgradeContext.state.set(key, value);
    },
  };

  const handleOpen = (): void => {
    void Promise.resolve(route.handlers.onOpen?.(conn, upgradeContext)).catch((err: unknown) => {
      void route.handlers.onError?.(conn, err);
      conn.close(1011, 'Internal server error');
    });
  };

  const handleMessage = (event: { readonly data: string | ArrayBuffer | Uint8Array }): void => {
    const payload = normalizeEdgeWsPayload(event.data);
    const byteSize =
      typeof payload === 'string' ? new TextEncoder().encode(payload).byteLength : payload.byteLength;
    if (byteSize > route.maxPayloadBytes) {
      conn.close(1009, 'Message Too Big');
      return;
    }
    void Promise.resolve(route.handlers.onMessage?.(conn, payload)).catch((err: unknown) => {
      void route.handlers.onError?.(conn, err);
    });
  };

  const handleClose = (event: {
    readonly code?: number;
    readonly reason?: string;
    readonly wasClean?: boolean;
  }): void => {
    readyState = 'closed';
    const code = event.code ?? 1000;
    void Promise.resolve(
      route.handlers.onClose?.(conn, {
        code,
        reason: event.reason ?? '',
        wasClean: event.wasClean ?? code === 1000,
      }),
    ).catch(() => {});
  };

  const handleError = (event: unknown): void => {
    void Promise.resolve(route.handlers.onError?.(conn, event)).catch(() => {});
  };

  if (typeof socket.addEventListener === 'function') {
    socket.addEventListener('message', (ev) =>
      handleMessage(ev as { readonly data: string | ArrayBuffer | Uint8Array }),
    );
    socket.addEventListener('close', (ev) =>
      handleClose(
        ev as { readonly code?: number; readonly reason?: string; readonly wasClean?: boolean },
      ),
    );
    socket.addEventListener('error', (ev) => handleError(ev));
    if (acceptImmediately) {
      socket.accept?.();
      handleOpen();
    } else {
      socket.addEventListener('open', () => handleOpen());
    }
  } else {
    socket.onmessage = handleMessage;
    socket.onclose = handleClose;
    socket.onerror = handleError;
    if (acceptImmediately) {
      socket.accept?.();
      handleOpen();
    } else {
      socket.onopen = () => handleOpen();
    }
  }
}

function createEdgeWsUpgradeResponse(webSocket: unknown): Response {
  try {
    return new Response(null, {
      status: 101,
      webSocket,
    } as unknown as ResponseInit);
  } catch {
    const res = new Response(null, { status: 200 });
    Object.defineProperty(res, 'status', { value: 101, configurable: true });
    Object.defineProperty(res, 'statusText', { value: 'Switching Protocols', configurable: true });
    Object.defineProperty(res, 'webSocket', { value: webSocket, configurable: true });
    return res;
  }
}

export function createEdgeHandler<TEnv = unknown>(
  target: FetchHandler | EdgeAppTarget,
  options: EdgeHandlerOptions<TEnv> = {},
): (
  request: Request,
  env?: TEnv,
  execCtx?: EdgeExecutionContextLike,
) => Promise<Response> {
  const fetchFn: FetchHandler = isFetchAppTarget(target) ? target.fetch : target;
  const runtime = options.runtime ?? 'edge';
  const ensureStarted = createBootStarter(target, options.autoStart ?? true);
  const trustCfIp = options.trustCfConnectingIp ?? false;

  return async function handleEdgeRequest(
    request: Request,
    env?: TEnv,
    execCtx?: EdgeExecutionContextLike,
  ): Promise<Response> {
    if (env !== undefined) {
      EDGE_ENV_MAP.set(request, env);
    }
    if (execCtx !== undefined) {
      EDGE_CTX_MAP.set(request, execCtx);
    }

    try {
      await ensureStarted();

      let remoteAddress = options.resolveRemoteAddress?.(request, env);
      if (remoteAddress === undefined && trustCfIp) {
        const cfIp = request.headers.get('cf-connecting-ip')?.trim();
        if (cfIp) {
          remoteAddress = cfIp;
        }
      }

      const meta: RuntimeRequestMeta = {
        runtime,
        signal: request.signal,
        ...(remoteAddress !== undefined ? { remoteAddress } : {}),
      };

      if (
        request.headers.get('upgrade')?.toLowerCase() === 'websocket' &&
        typeof fetchFn.authorizeWebSocketUpgrade === 'function'
      ) {
        const decision = await fetchFn.authorizeWebSocketUpgrade(request, meta);
        if (!decision.accepted) {
          return decision.response;
        }
        const PairCtor =
          options.webSocketPair ??
          (globalThis as unknown as { readonly WebSocketPair?: EdgeWebSocketPairConstructor })
            .WebSocketPair;
        if (typeof PairCtor !== 'function') {
          return unsupportedEdgeWsResponse(runtime);
        }
        const pair = new PairCtor();
        bindEdgeWebSocketLifecycle(pair[1], decision, true);
        return createEdgeWsUpgradeResponse(pair[0]);
      }

      return await fetchFn(request, meta);
    } catch {
      return internalErrorResponse();
    }
  };
}

export function createCloudflareWorkerHandler<TEnv = unknown>(
  target: FetchHandler | EdgeAppTarget,
  options: CloudflareWorkerHandlerOptions<TEnv> = {},
): CloudflareWorkerModule<TEnv> {
  const handler = createEdgeHandler<TEnv>(target, {
    ...options,
    runtime: options.runtime ?? 'cloudflare-workers',
  });

  return {
    fetch: (request, env, ctx) => handler(request, env, ctx),
  };
}

export function createDenoHandler(
  target: FetchHandler | EdgeAppTarget,
  options: DenoHandlerOptions = {},
): (request: Request, info?: DenoServeHandlerInfoLike) => Promise<Response> {
  const fetchFn: FetchHandler = isFetchAppTarget(target) ? target.fetch : target;
  const runtime = options.runtime ?? 'deno';
  const ensureStarted = createBootStarter(target, options.autoStart ?? true);

  return async function handleDenoRequest(
    request: Request,
    info?: DenoServeHandlerInfoLike,
  ): Promise<Response> {
    try {
      await ensureStarted();

      const remoteAddress =
        options.resolveRemoteAddress?.(request, undefined as never) ?? info?.remoteAddr?.hostname;
      const meta: RuntimeRequestMeta = {
        runtime,
        signal: request.signal,
        ...(remoteAddress !== undefined ? { remoteAddress } : {}),
      };

      if (
        request.headers.get('upgrade')?.toLowerCase() === 'websocket' &&
        typeof fetchFn.authorizeWebSocketUpgrade === 'function'
      ) {
        const decision = await fetchFn.authorizeWebSocketUpgrade(request, meta);
        if (!decision.accepted) {
          return decision.response;
        }
        const upgradeFn =
          options.upgradeWebSocket ??
          (
            globalThis as unknown as {
              readonly Deno?: { readonly upgradeWebSocket?: DenoUpgradeWebSocketFn };
            }
          ).Deno?.upgradeWebSocket;
        if (typeof upgradeFn !== 'function') {
          return unsupportedEdgeWsResponse(runtime);
        }
        const { response, socket } = upgradeFn(
          request,
          decision.upgradeContext.protocol
            ? { protocol: decision.upgradeContext.protocol }
            : undefined,
        );
        bindEdgeWebSocketLifecycle(socket, decision, false);
        return response;
      }

      return await fetchFn(request, meta);
    } catch {
      return internalErrorResponse();
    }
  };
}

export interface EdgeAdapterOptions {
  readonly runtime?: string;
}

export class EdgeAdapter implements HttpRuntimeAdapter {
  public readonly name = 'edge';
  public readonly runtime: string;

  public constructor(options: EdgeAdapterOptions = {}) {
    this.runtime = options.runtime ?? 'edge';
  }

  public async listen(_handler: FetchHandler, _options: ListenOptions): Promise<ServerAddress> {
    throw new ForgeHttpError(
      'EdgeAdapter runs on serverless Fetch isolates without binding a TCP socket. Export createCloudflareWorkerHandler(app) or createEdgeHandler(app) instead.',
      {
        code: 'EDGE_LISTEN_UNSUPPORTED',
        statusCode: 500,
        expose: false,
      },
    );
  }

  public async close(): Promise<void> {
    // No persistent socket listener in Fetch isolate adapters
  }
}

export function createEdgeAdapter(options?: EdgeAdapterOptions): EdgeAdapter {
  return new EdgeAdapter(options);
}
