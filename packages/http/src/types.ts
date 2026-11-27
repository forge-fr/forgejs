import type {
  ApplicationKernel,
  Container,
  ForgeLogger,
  InjectionToken,
  KernelOptions,
  RegisterOptions,
  AnyProviderDefinition,
  ForgeModule,
} from '@forge-fr/core';
import type {
  GroupOptions,
  HttpMethod,
  ParamConstraint,
  RegisteredRoute,
  RouteBuilder,
  RouteOptions,
  RouterOptions,
} from '@forge-fr/router';

export type WebSocketMessageData = string | Uint8Array;

export interface WebSocketCloseInfo {
  readonly code: number;
  readonly reason: string;
  readonly wasClean: boolean;
}

export interface WebSocketUpgradeContext {
  readonly request: Request;
  readonly url: URL;
  readonly path: string;
  readonly headers: Headers;
  readonly params: Readonly<Record<string, string>>;
  readonly query: Readonly<Record<string, string>>;
  readonly remoteAddress?: string;
  readonly runtime: string;
  readonly protocol: string;
  readonly state: Map<string, unknown>;
}

export interface WebSocketConnection {
  readonly id: string;
  readonly url: URL;
  readonly headers: Headers;
  readonly params: Readonly<Record<string, string>>;
  readonly remoteAddress?: string;
  readonly protocol: string;
  readonly readyState: 'open' | 'closing' | 'closed';
  send(data: WebSocketMessageData): void;
  close(code?: number, reason?: string): void;
  ping(data?: WebSocketMessageData): void;
  getState<T = unknown>(key: string): T | undefined;
  setState<T = unknown>(key: string, value: T): void;
}

export interface WebSocketHandlers {
  readonly authenticate?: (ctx: WebSocketUpgradeContext) => Promise<boolean> | boolean;
  readonly onOpen?: (ws: WebSocketConnection, ctx: WebSocketUpgradeContext) => Promise<void> | void;
  readonly onMessage?: (
    ws: WebSocketConnection,
    message: WebSocketMessageData,
  ) => Promise<void> | void;
  readonly onClose?: (ws: WebSocketConnection, info: WebSocketCloseInfo) => Promise<void> | void;
  readonly onError?: (ws: WebSocketConnection, error: unknown) => Promise<void> | void;
  readonly onPong?: (ws: WebSocketConnection, data: Uint8Array) => Promise<void> | void;
}

export interface WebSocketRouteOptions {
  /** Exact Origin allowlist (CSWSH defense). Rejects non-matching Origin headers with HTTP 403. */
  readonly allowedOrigins?: readonly string[];
  /** Maximum message payload size in bytes. Default: `1048576` (1 MiB). */
  readonly maxPayloadBytes?: number;
  /** Optional WebSocket subprotocol allowlist offered by this endpoint. */
  readonly protocols?: readonly string[];
  /** Route parameter constraints. */
  readonly constraints?: Readonly<Record<string, ParamConstraint>>;
}

export interface RegisteredWebSocketRoute {
  readonly path: string;
  readonly handlers: WebSocketHandlers;
  readonly options: WebSocketRouteOptions;
  readonly maxPayloadBytes: number;
}

export type WebSocketUpgradeCheckResult =
  | {
      readonly accepted: true;
      readonly route: RegisteredWebSocketRoute;
      readonly upgradeContext: WebSocketUpgradeContext;
    }
  | {
      readonly accepted: false;
      readonly response: Response;
    };

export interface ListenOptions {
  readonly port: number;
  readonly host?: string;
  readonly signal?: AbortSignal;
  readonly maxBodyBytes?: number;
  readonly requestTimeoutMs?: number;
  readonly shutdownTimeoutMs?: number;
}

export interface ServerAddress {
  readonly host: string;
  readonly port: number;
  readonly protocol: 'http' | 'https';
  readonly url: string;
}

export interface RuntimeRequestMeta {
  readonly remoteAddress?: string | undefined;
  readonly signal?: AbortSignal;
  readonly runtime?: 'node' | 'bun' | 'memory' | (string & {});
  readonly path?: string;
  readonly headers?: Headers;
}

export type FetchHandler = ((
  request: Request,
  meta?: RuntimeRequestMeta,
) => Promise<Response> | Response) & {
  readonly authorizeWebSocketUpgrade?: (
    request: Request,
    meta?: RuntimeRequestMeta,
  ) => Promise<WebSocketUpgradeCheckResult>;
};

export interface HttpRuntimeAdapter {
  readonly name: string;
  readonly runtime: 'node' | 'bun' | 'memory' | (string & {});
  listen(handler: FetchHandler, options: ListenOptions): Promise<ServerAddress>;
  close(timeoutMs?: number): Promise<void>;
}

export type MiddlewareTier = 'global' | 'module' | 'group' | 'route';

export type MiddlewareNext = () => Promise<Response>;

export type ForgeMiddleware = (
  ctx: ForgeContext,
  next: MiddlewareNext,
) => Promise<Response | void> | Response | void;

export interface MiddlewareRegistrationOptions {
  readonly tier?: MiddlewareTier;
  readonly priority?: number;
  readonly name?: string;
}

export interface RegisteredMiddleware {
  readonly fn: ForgeMiddleware;
  readonly tier: MiddlewareTier;
  readonly priority: number;
  readonly sequence: number;
  readonly name?: string;
}

export interface BodyParseOptions {
  readonly maxBytes?: number;
  readonly allowProtoKeys?: boolean;
}

export interface MultipartParseOptions {
  readonly maxBytes?: number;
  readonly maxFields?: number;
  readonly maxFiles?: number;
  readonly maxFileBytes?: number;
}

export interface UploadedFile {
  readonly fieldName: string;
  readonly name: string;
  readonly type: string;
  readonly size: number;
  readonly blob: Blob;
  arrayBuffer(): Promise<ArrayBuffer>;
  text(): Promise<string>;
}

export interface ParsedMultipart {
  readonly fields: Readonly<Record<string, string | readonly string[]>>;
  readonly files: readonly UploadedFile[];
}

export interface RequestBodyReader {
  bytes(options?: Pick<BodyParseOptions, 'maxBytes'>): Promise<Uint8Array>;
  arrayBuffer(options?: Pick<BodyParseOptions, 'maxBytes'>): Promise<ArrayBuffer>;
  text(options?: Pick<BodyParseOptions, 'maxBytes'>): Promise<string>;
  json<T = unknown>(options?: BodyParseOptions): Promise<T>;
  form(options?: Pick<BodyParseOptions, 'maxBytes'>): Promise<Readonly<Record<string, string | readonly string[]>>>;
  multipart(options?: MultipartParseOptions): Promise<ParsedMultipart>;
}

export interface SseEvent {
  readonly id?: string;
  readonly event?: string;
  readonly data: unknown;
  readonly retry?: number;
}

export interface SseStreamController {
  readonly closed: boolean;
  send(event: SseEvent): void;
  comment(text: string): void;
  close(): void;
}

export type SseProducer = (stream: SseStreamController) => Promise<void> | void;

export type RedirectStatusCode = 301 | 302 | 303 | 307 | 308;

export interface ResponseHelperInit {
  readonly status?: number;
  readonly headers?: HeadersInit;
}

export interface ForgeContext {
  readonly request: Request;
  readonly method: string;
  readonly url: URL;
  readonly path: string;
  readonly headers: Headers;
  readonly params: Readonly<Record<string, string>>;
  readonly query: Readonly<Record<string, string>>;
  readonly requestId: string;
  readonly remoteAddress?: string | undefined;
  readonly runtime: string;
  readonly signal: AbortSignal;
  readonly logger: ForgeLogger;
  readonly container: Container;
  readonly routeMeta: Readonly<Record<string, unknown>>;
  readonly body: RequestBodyReader;
  readonly committed: boolean;

  header(name: string): string | null;
  queryAll(name: string): readonly string[];
  accepts(offered: readonly string[]): string | null;
  resolve<T>(token: InjectionToken<T>): T;
  resolveOptional<T>(token: InjectionToken<T>): T | undefined;
  getState<T = unknown>(key: string): T | undefined;
  setState<T = unknown>(key: string, value: T): this;
  hasState(key: string): boolean;

  status(code: number): this;
  setHeader(name: string, value: string): this;
  appendHeader(name: string, value: string): this;
  removeHeader(name: string): this;

  json(data: unknown, init?: ResponseHelperInit): Response;
  text(body: string, init?: ResponseHelperInit): Response;
  html(body: string, init?: ResponseHelperInit): Response;
  bytes(body: Uint8Array, contentType?: string, init?: ResponseHelperInit): Response;
  empty(statusCode?: number): Response;
  redirect(location: string, statusCode?: RedirectStatusCode): Response;
  stream(body: ReadableStream<Uint8Array>, contentType?: string, init?: ResponseHelperInit): Response;
  sse(producer: SseProducer, init?: Omit<ResponseHelperInit, 'status'>): Response;
}

export type RouteHandlerResult =
  | Response
  | Record<string, unknown>
  | readonly unknown[]
  | string
  | number
  | boolean
  | null
  | void;

export type ForgeRouteHandler = (
  ctx: ForgeContext,
) => Promise<RouteHandlerResult> | RouteHandlerResult;

export type HttpRouteOptions = RouteOptions<ForgeMiddleware>;
export type HttpGroupOptions = GroupOptions<ForgeMiddleware>;

export interface OnRequestHookPayload {
  readonly ctx: ForgeContext;
}

export interface PreValidationHookPayload {
  readonly ctx: ForgeContext;
}

export interface PreHandlerHookPayload {
  readonly ctx: ForgeContext;
}

export interface PreSerializationHookPayload {
  readonly ctx: ForgeContext;
  readonly payload: unknown;
}

export interface OnSendHookPayload {
  readonly ctx: ForgeContext;
  readonly response: Response;
}

export interface OnErrorHookPayload {
  readonly ctx: ForgeContext;
  readonly error: unknown;
}

export interface OnResponseHookPayload {
  readonly ctx: ForgeContext;
  readonly statusCode: number;
  readonly durationMs: number;
}

export interface HttpHookHandlerMap {
  onRequest: (payload: OnRequestHookPayload) => Promise<Response | void> | Response | void;
  preValidation: (payload: PreValidationHookPayload) => Promise<Response | void> | Response | void;
  preHandler: (payload: PreHandlerHookPayload) => Promise<Response | void> | Response | void;
  preSerialization: (payload: PreSerializationHookPayload) => Promise<unknown> | unknown;
  onSend: (payload: OnSendHookPayload) => Promise<Response | void> | Response | void;
  onError: (payload: OnErrorHookPayload) => Promise<Response | void> | Response | void;
  onResponse: (payload: OnResponseHookPayload) => Promise<void> | void;
}

export type HttpHookName = keyof HttpHookHandlerMap;

export interface HttpHookOptions {
  readonly priority?: number;
}

export interface HttpAppOptions extends KernelOptions {
  readonly adapter?: HttpRuntimeAdapter;
  readonly router?: RouterOptions;
  readonly production?: boolean;
  readonly maxBodyBytes?: number;
  readonly trustRequestId?: boolean;
  readonly requestIdHeader?: string;
  readonly generateRequestId?: () => string;
}

export interface ForgeHttpApp extends RouteBuilder<ForgeRouteHandler, ForgeMiddleware> {
  readonly kernel: ApplicationKernel;
  readonly address: ServerAddress | null;
  readonly fetch: FetchHandler;
  use(middleware: ForgeMiddleware, options?: MiddlewareRegistrationOptions): this;
  addHook<K extends HttpHookName>(
    name: K,
    handler: HttpHookHandlerMap[K],
    options?: HttpHookOptions,
  ): this;
  registerModule(mod: ForgeModule): this;
  registerProvider(provider: AnyProviderDefinition, options?: RegisterOptions): this;
  routes(): readonly RegisteredRoute<ForgeRouteHandler, ForgeMiddleware>[];
  ws(path: string, handlers: WebSocketHandlers, options?: WebSocketRouteOptions): this;
  wsRoutes(): readonly RegisteredWebSocketRoute[];
  authorizeWebSocketUpgrade(
    request: Request,
    meta?: RuntimeRequestMeta,
  ): Promise<WebSocketUpgradeCheckResult>;
  start(): Promise<void>;
  listen(options: ListenOptions): Promise<ServerAddress>;
  close(timeoutMs?: number): Promise<void>;
  dispose(): Promise<void>;
}

export type { HttpMethod, RegisteredRoute };
