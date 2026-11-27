import {
  NotFoundError,
  createKernel,
  normalizeError,
  type AnyProviderDefinition,
  type ApplicationKernel,
  type ForgeModule,
  type RegisterOptions,
} from '@forge-fr/core';
import {
  createRouter,
  type HttpMethod,
  type RegisteredRoute,
  type RouteBuilder,
  type Router,
} from '@forge-fr/router';
import { DEFAULT_MAX_BODY_BYTES } from './body.js';
import {
  ForgeContextImpl,
  extractPathname,
  type ContextAppConfig,
  type FastHeaderMeta,
} from './context.js';
import { ForgeHttpError, MethodNotAllowedError } from './errors.js';
import { FastResponse, copyFastBody } from './fast-body.js';
import { composeMiddleware, sortMiddleware } from './middleware.js';
import type {
  FetchHandler,
  ForgeContext,
  ForgeHttpApp,
  ForgeMiddleware,
  ForgeRouteHandler,
  HttpAppOptions,
  HttpGroupOptions,
  HttpHookHandlerMap,
  HttpHookName,
  HttpHookOptions,
  HttpRouteOptions,
  HttpRuntimeAdapter,
  ListenOptions,
  MiddlewareRegistrationOptions,
  RegisteredMiddleware,
  RouteHandlerResult,
  RuntimeRequestMeta,
  ServerAddress,
} from './types.js';
import {
  WebSocketRouteRegistry,
  type RegisteredWebSocketRoute,
  type WebSocketHandlers,
  type WebSocketRouteOptions,
  type WebSocketUpgradeCheckResult,
} from './websocket.js';

const SAFE_REQUEST_ID_REGEX = /^[A-Za-z0-9._:-]{1,128}$/;

interface StoredHook<K extends HttpHookName = HttpHookName> {
  readonly handler: HttpHookHandlerMap[K];
  readonly priority: number;
  readonly sequence: number;
}

interface InlineCachedRoute extends RegisteredRoute<ForgeRouteHandler, ForgeMiddleware> {
  _pipelineVersion?: number;
  _pipelineRun?: (ctx: ForgeContextImpl) => Promise<Response> | Response;
}

let requestIdCounter = 0;
const REQUEST_ID_PREFIX = `req-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}-`;

function defaultGenerateRequestId(): string {
  requestIdCounter += 1;
  return `${REQUEST_ID_PREFIX}${requestIdCounter.toString(36)}`;
}

function resolveTrustedIncomingRequestId(
  request: Request,
  headerName: string,
): string | undefined {
  const incoming = request.headers.get(headerName)?.trim();
  if (incoming && SAFE_REQUEST_ID_REGEX.test(incoming)) {
    return incoming;
  }
  return undefined;
}

function finalizeHttpSemantics(
  requestMethod: string,
  response: Response,
  requestIdHeader: string,
  requestId: string | undefined,
): Response {
  const isNoBodyStatus = response.status === 204 || response.status === 304;
  if (requestMethod === 'HEAD' || isNoBodyStatus) {
    if (response instanceof FastResponse) {
      const fh = response.ensureFastHeaders();
      if (requestId !== undefined && !fh.has(requestIdHeader)) {
        fh.set(requestIdHeader, requestId);
      }
      if (response._rawBody === null) {
        return response;
      }
      return new FastResponse(null, response._status, fh, response._contentType) as unknown as Response;
    }

    const headers = new Headers(response.headers);
    if (requestId !== undefined && !headers.has(requestIdHeader)) {
      headers.set(requestIdHeader, requestId);
    }
    if (response.body !== null) {
      response.body.cancel().catch(() => {
        // Ignore cancellation error on closed stream
      });
    }
    return new Response(null, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }

  if (requestId === undefined) {
    return response;
  }

  if (response instanceof FastResponse) {
    const fh = response.ensureFastHeaders();
    if (fh._map[requestIdHeader] === undefined) {
      fh._map[requestIdHeader] = requestId;
    }
    return response;
  }

  if (response.headers.has(requestIdHeader)) {
    return response;
  }

  try {
    response.headers.set(requestIdHeader, requestId);
    return response;
  } catch {
    // Immutable Headers instance (e.g. direct fetch() proxy response)
    const headers = new Headers(response.headers);
    headers.set(requestIdHeader, requestId);
    const cloned = new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
    return copyFastBody(response, cloned);
  }
}

class ForgeHttpAppImpl implements ForgeHttpApp {
  public readonly kernel: ApplicationKernel;
  public readonly fetch: FetchHandler;

  private readonly router: Router<ForgeRouteHandler, ForgeMiddleware>;
  private readonly wsRegistry = new WebSocketRouteRegistry();
  private readonly adapter?: HttpRuntimeAdapter;
  private readonly production: boolean;
  private readonly trustRequestId: boolean;
  private readonly requestIdHeader: string;
  private readonly ctxConfig: ContextAppConfig;

  private readonly appMiddlewares: RegisteredMiddleware[] = [];
  private sortedAppMwCache: readonly ForgeMiddleware[] | null = null;
  private pipelineVersion = 1;
  private hasOuterHooks = false;

  private middlewareSeq = 0;
  private hookSeq = 0;
  private readonly hooks: { [K in HttpHookName]: StoredHook<K>[] } = {
    onRequest: [],
    preValidation: [],
    preHandler: [],
    preSerialization: [],
    onSend: [],
    onError: [],
    onResponse: [],
  };

  private currentAddress: ServerAddress | null = null;

  public constructor(options: HttpAppOptions = {}) {
    this.kernel = createKernel(options);
    this.router = createRouter<ForgeRouteHandler, ForgeMiddleware>(options.router);
    if (options.adapter !== undefined) {
      this.adapter = options.adapter;
    }
    this.production = options.production ?? true;
    this.trustRequestId = options.trustRequestId ?? false;
    this.requestIdHeader = (options.requestIdHeader ?? 'x-request-id').toLowerCase();
    const generateRequestId = options.generateRequestId ?? defaultGenerateRequestId;
    this.ctxConfig = {
      defaultRuntime: options.adapter?.runtime ?? 'fetch',
      requestIdHeader: this.requestIdHeader,
      requestIdFactory: generateRequestId,
      logger: this.kernel.logger,
      createRequestScope: () => this.kernel.createRequestScope(),
      defaultMaxBytes: options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES,
    };

    const handlerFn = (request: Request, meta?: RuntimeRequestMeta): Promise<Response> | Response =>
      this.handleRequest(request, meta);
    (handlerFn as { authorizeWebSocketUpgrade?: FetchHandler['authorizeWebSocketUpgrade'] }).authorizeWebSocketUpgrade =
      (request: Request, meta?: RuntimeRequestMeta) => this.authorizeWebSocketUpgrade(request, meta);
    this.fetch = handlerFn;
  }

  public get address(): ServerAddress | null {
    return this.currentAddress;
  }

  public use(middleware: ForgeMiddleware, options: MiddlewareRegistrationOptions = {}): this {
    const entry: RegisteredMiddleware = {
      fn: middleware,
      tier: options.tier ?? 'global',
      priority: options.priority ?? 0,
      sequence: this.middlewareSeq++,
      ...(options.name !== undefined ? { name: options.name } : {}),
    };
    this.appMiddlewares.push(entry);
    this.sortedAppMwCache = null;
    this.pipelineVersion += 1;
    return this;
  }

  public addHook<K extends HttpHookName>(
    name: K,
    handler: HttpHookHandlerMap[K],
    options: HttpHookOptions = {},
  ): this {
    const bucket = this.hooks[name] as StoredHook<K>[];
    bucket.push({
      handler,
      priority: options.priority ?? 0,
      sequence: this.hookSeq++,
    });
    bucket.sort((a, b) => (a.priority !== b.priority ? a.priority - b.priority : a.sequence - b.sequence));
    if (name === 'preValidation' || name === 'preHandler' || name === 'preSerialization') {
      this.pipelineVersion += 1;
    }
    if (name === 'onRequest' || name === 'onSend' || name === 'onResponse') {
      this.hasOuterHooks = true;
    }
    return this;
  }

  public registerModule(mod: ForgeModule): this {
    this.kernel.registerModule(mod);
    return this;
  }

  public registerProvider(provider: AnyProviderDefinition, options?: RegisterOptions): this {
    this.kernel.registerProvider(provider, options);
    return this;
  }

  public add(
    method: HttpMethod,
    path: string,
    handler: ForgeRouteHandler,
    options?: HttpRouteOptions,
  ): this {
    this.router.add(method, path, handler, options);
    return this;
  }

  public get(path: string, handler: ForgeRouteHandler, options?: HttpRouteOptions): this {
    this.router.get(path, handler, options);
    return this;
  }

  public post(path: string, handler: ForgeRouteHandler, options?: HttpRouteOptions): this {
    this.router.post(path, handler, options);
    return this;
  }

  public put(path: string, handler: ForgeRouteHandler, options?: HttpRouteOptions): this {
    this.router.put(path, handler, options);
    return this;
  }

  public patch(path: string, handler: ForgeRouteHandler, options?: HttpRouteOptions): this {
    this.router.patch(path, handler, options);
    return this;
  }

  public delete(path: string, handler: ForgeRouteHandler, options?: HttpRouteOptions): this {
    this.router.delete(path, handler, options);
    return this;
  }

  public options(path: string, handler: ForgeRouteHandler, options?: HttpRouteOptions): this {
    this.router.options(path, handler, options);
    return this;
  }

  public head(path: string, handler: ForgeRouteHandler, options?: HttpRouteOptions): this {
    this.router.head(path, handler, options);
    return this;
  }

  public all(path: string, handler: ForgeRouteHandler, options?: HttpRouteOptions): this {
    this.router.all(path, handler, options);
    return this;
  }

  public group(
    prefix: string,
    configure: (group: RouteBuilder<ForgeRouteHandler, ForgeMiddleware>) => void,
    options?: HttpGroupOptions,
  ): this {
    this.router.group(prefix, configure, options);
    return this;
  }

  public routes(): readonly RegisteredRoute<ForgeRouteHandler, ForgeMiddleware>[] {
    return this.router.routes();
  }

  public ws(
    path: string,
    handlers: WebSocketHandlers,
    options?: WebSocketRouteOptions,
  ): this {
    this.wsRegistry.register(path, handlers, options);
    return this;
  }

  public wsRoutes(): readonly RegisteredWebSocketRoute[] {
    return this.wsRegistry.list();
  }

  public authorizeWebSocketUpgrade(
    request: Request,
    meta?: RuntimeRequestMeta,
  ): Promise<WebSocketUpgradeCheckResult> {
    return this.wsRegistry.authorizeUpgrade(request, meta);
  }

  public async start(): Promise<void> {
    await this.kernel.start();
  }

  public async listen(options: ListenOptions): Promise<ServerAddress> {
    if (!this.adapter) {
      throw new ForgeHttpError(
        'Cannot call listen() without an HttpRuntimeAdapter configured in createHttpApp({ adapter })',
        { code: 'NO_HTTP_ADAPTER', statusCode: 500, expose: false },
      );
    }
    if (this.kernel.state !== 'ready') {
      await this.kernel.start();
    }
    const handlerFn = this.fetch as FetchHandler & {
      hasWebSocketRoutes?: boolean;
    };
    handlerFn.hasWebSocketRoutes = this.wsRegistry.list().length > 0;
    this.currentAddress = await this.adapter.listen(this.fetch, options);
    return this.currentAddress;
  }

  public async close(timeoutMs?: number): Promise<void> {
    if (this.adapter && this.currentAddress !== null) {
      await this.adapter.close(timeoutMs);
      this.currentAddress = null;
    }
    await this.kernel.shutdown();
  }

  public async dispose(): Promise<void> {
    if (this.adapter && this.currentAddress !== null) {
      await this.adapter.close();
      this.currentAddress = null;
    }
    await this.kernel.dispose();
  }

  private getSortedAppMiddleware(): readonly ForgeMiddleware[] {
    if (this.sortedAppMwCache === null) {
      this.sortedAppMwCache =
        this.appMiddlewares.length === 0
          ? []
          : sortMiddleware(this.appMiddlewares).map((m) => m.fn);
    }
    return this.sortedAppMwCache;
  }

  private getRoutePipeline(
    route: InlineCachedRoute,
  ): (ctx: ForgeContextImpl) => Promise<Response> | Response {
    if (route._pipelineVersion === this.pipelineVersion && route._pipelineRun !== undefined) {
      return route._pipelineRun;
    }

    const appMws = this.getSortedAppMiddleware();
    const routeMws = route.middleware;
    const hasPreValidation = this.hooks.preValidation.length > 0;
    const hasPreHandler = this.hooks.preHandler.length > 0;
    const hasPreSerialization = this.hooks.preSerialization.length > 0;

    let run: (ctx: ForgeContextImpl) => Promise<Response> | Response;

    if (appMws.length === 0 && routeMws.length === 0 && !hasPreValidation && !hasPreHandler) {
      if (!hasPreSerialization) {
        const handler = route.handler;
        run = (ctx: ForgeContextImpl): Promise<Response> | Response => {
          const rawResult = handler(ctx);
          if (rawResult instanceof Response) {
            return rawResult;
          }
          if (rawResult instanceof Promise) {
            return rawResult.then((resolved) =>
              resolved instanceof Response
                ? resolved
                : this.serializeHandlerResult(ctx, resolved),
            );
          }
          return this.serializeHandlerResult(ctx, rawResult);
        };
      } else {
        run = (ctx: ForgeContextImpl): Promise<Response> | Response => {
          const rawResult = route.handler(ctx);
          if (rawResult instanceof Promise) {
            return rawResult.then((resolved) => this.serializeHandlerResult(ctx, resolved));
          }
          return this.serializeHandlerResult(ctx, rawResult);
        };
      }
    } else {
      const allMiddlewares =
        routeMws.length === 0
          ? appMws
          : appMws.length === 0
            ? routeMws
            : [...appMws, ...routeMws];

      const terminal = (activeCtx: ForgeContext): Promise<Response> | Response => {
        const implCtx = activeCtx as ForgeContextImpl;
        if (!hasPreValidation && !hasPreHandler) {
          const rawResult = route.handler(implCtx);
          if (rawResult instanceof Response && !hasPreSerialization) {
            return rawResult;
          }
          if (rawResult instanceof Promise) {
            return rawResult.then((resolved) =>
              resolved instanceof Response && !hasPreSerialization
                ? resolved
                : this.serializeHandlerResult(implCtx, resolved),
            );
          }
          return this.serializeHandlerResult(implCtx, rawResult);
        }

        return (async (): Promise<Response> => {
          if (hasPreValidation) {
            for (const entry of this.hooks.preValidation) {
              const res = await entry.handler({ ctx: implCtx });
              if (res instanceof Response) return res;
            }
          }
          if (hasPreHandler) {
            for (const entry of this.hooks.preHandler) {
              const res = await entry.handler({ ctx: implCtx });
              if (res instanceof Response) return res;
            }
          }
          const rawResult = await route.handler(implCtx);
          return this.serializeHandlerResult(implCtx, rawResult);
        })();
      };

      const composed =
        allMiddlewares.length === 0 ? terminal : composeMiddleware(allMiddlewares, terminal);
      run = (ctx: ForgeContextImpl): Promise<Response> | Response => composed(ctx);
    }

    route._pipelineVersion = this.pipelineVersion;
    route._pipelineRun = run;
    return run;
  }

  private serializeHandlerResult(
    ctx: ForgeContextImpl,
    rawResult: RouteHandlerResult,
  ): Promise<Response> | Response {
    if (this.hooks.preSerialization.length === 0) {
      if (rawResult instanceof Response) {
        return rawResult;
      }
      if (rawResult === undefined) {
        return ctx.empty(ctx.getStagedStatus() === 200 ? 204 : ctx.getStagedStatus());
      }
      if (typeof rawResult === 'string') {
        return ctx.text(rawResult);
      }
      return ctx.json(rawResult);
    }

    return this.serializeHandlerResultWithHooks(ctx, rawResult);
  }

  private async serializeHandlerResultWithHooks(
    ctx: ForgeContextImpl,
    rawResult: RouteHandlerResult,
  ): Promise<Response> {
    if (rawResult instanceof Response) {
      return rawResult;
    }
    let payload: unknown = rawResult;
    for (const entry of this.hooks.preSerialization) {
      payload = await entry.handler({ ctx, payload });
    }
    if (payload instanceof Response) {
      return payload;
    }
    if (payload === undefined) {
      return ctx.empty(ctx.getStagedStatus() === 200 ? 204 : ctx.getStagedStatus());
    }
    if (typeof payload === 'string') {
      return ctx.text(payload);
    }
    return ctx.json(payload);
  }

  private async handleError(ctx: ForgeContextImpl, error: unknown): Promise<Response> {
    if (this.hooks.onError.length > 0) {
      for (const entry of this.hooks.onError) {
        try {
          const custom = await entry.handler({ ctx, error });
          if (custom instanceof Response) {
            return custom;
          }
        } catch (hookErr: unknown) {
          ctx.logger.error('Error inside onError hook', { error: hookErr });
        }
      }
    }

    const normalized = normalizeError(error);
    if (normalized.statusCode >= 500) {
      ctx.logger.error('Unhandled HTTP request error', {
        code: normalized.code,
        statusCode: normalized.statusCode,
        error,
      });
    }

    const reqId = ctx.requestId;
    const body = normalized.toPublicJSON({
      production: this.production,
      requestId: reqId,
    });

    const extraHeaders = error instanceof ForgeHttpError ? error.headers : undefined;
    const headers = new Headers(extraHeaders);
    headers.set('content-type', 'application/json; charset=utf-8');
    headers.set(this.requestIdHeader, reqId);

    return new Response(JSON.stringify(body), {
      status: normalized.statusCode,
      headers,
    });
  }

  private async completeResolvedNoHooks(
    ctx: ForgeContextImpl,
    resolved: Response,
  ): Promise<Response> {
    let response = resolved;
    try {
      response = ctx.applyPendingHeaders(response);
      response = finalizeHttpSemantics(
        ctx.method,
        response,
        this.requestIdHeader,
        ctx._requestId,
      );
      ctx.markCommitted();
    } catch (sendErr: unknown) {
      response = await this.handleError(ctx, sendErr);
      response = finalizeHttpSemantics(
        ctx.method,
        response,
        this.requestIdHeader,
        ctx._requestId,
      );
      ctx.markCommitted();
    } finally {
      const d = ctx.dispose();
      if (d !== undefined) {
        await d;
      }
    }
    return response;
  }

  private async completeErrorNoHooks(
    ctx: ForgeContextImpl,
    err: unknown,
  ): Promise<Response> {
    let response = await this.handleError(ctx, err);
    try {
      response = ctx.applyPendingHeaders(response);
      response = finalizeHttpSemantics(
        ctx.method,
        response,
        this.requestIdHeader,
        ctx._requestId,
      );
      ctx.markCommitted();
    } catch (sendErr: unknown) {
      response = await this.handleError(ctx, sendErr);
      response = finalizeHttpSemantics(
        ctx.method,
        response,
        this.requestIdHeader,
        ctx._requestId,
      );
      ctx.markCommitted();
    } finally {
      const d = ctx.dispose();
      if (d !== undefined) {
        await d;
      }
    }
    return response;
  }

  private handleRequest(
    request: Request,
    meta?: RuntimeRequestMeta,
  ): Promise<Response> | Response {
    if (this.hasOuterHooks) {
      return this.handleRequestWithHooks(request, meta);
    }

    const fastMeta = meta as (FastHeaderMeta & { readonly rawUrl?: string }) | undefined;
    const rawUrl = fastMeta?.rawUrl ?? request.url;
    const path = fastMeta?.path ?? extractPathname(rawUrl);
    const rawMethod = request.method;
    const method =
      rawMethod === 'GET' ||
      rawMethod === 'POST' ||
      rawMethod === 'PUT' ||
      rawMethod === 'DELETE' ||
      rawMethod === 'PATCH' ||
      rawMethod === 'HEAD' ||
      rawMethod === 'OPTIONS'
        ? rawMethod
        : rawMethod.toUpperCase();

    const trustedRequestId = this.trustRequestId
      ? resolveTrustedIncomingRequestId(request, this.requestIdHeader)
      : undefined;

    const ctx = ForgeContextImpl.createFast(
      request,
      method,
      rawUrl,
      path,
      this.ctxConfig,
      fastMeta,
      trustedRequestId,
    );

    try {
      const match = this.router.match(method, path);
      if (match.kind !== 'found') {
        if (match.kind === 'not_found') {
          throw new NotFoundError(`Route ${method} ${path} not found`);
        }
        throw new MethodNotAllowedError(match.allowedMethods, match.allowHeader);
      }

      const route = match.route as InlineCachedRoute;
      ctx._params = match.params;
      ctx._routeMeta = route.meta;

      const pipeline =
        route._pipelineVersion === this.pipelineVersion && route._pipelineRun !== undefined
          ? route._pipelineRun
          : this.getRoutePipeline(route);
      const resOrPromise = pipeline(ctx);

      if (resOrPromise instanceof Promise) {
        return resOrPromise.then(
          (resolved) => {
            if (
              ctx._cold === null &&
              ctx._requestId === undefined &&
              method !== 'HEAD' &&
              resolved.status !== 204 &&
              resolved.status !== 304
            ) {
              return resolved;
            }
            return this.completeResolvedNoHooks(ctx, resolved);
          },
          (err: unknown) => this.completeErrorNoHooks(ctx, err),
        );
      }

      if (
        ctx._cold === null &&
        ctx._requestId === undefined &&
        method !== 'HEAD' &&
        resOrPromise.status !== 204 &&
        resOrPromise.status !== 304
      ) {
        return resOrPromise;
      }

      let response = ctx.applyPendingHeaders(resOrPromise);
      response = finalizeHttpSemantics(
        method,
        response,
        this.requestIdHeader,
        ctx._requestId,
      );
      ctx.markCommitted();
      const d = ctx.dispose();
      if (d !== undefined) {
        return d.then(() => response);
      }
      return response;
    } catch (err: unknown) {
      return this.completeErrorNoHooks(ctx, err);
    }
  }

  private async handleRequestWithHooks(
    request: Request,
    meta?: RuntimeRequestMeta,
  ): Promise<Response> {
    const hasOnResponse = this.hooks.onResponse.length > 0;
    const startedAt = hasOnResponse ? Date.now() : 0;
    const fastMeta = meta as (FastHeaderMeta & { readonly rawUrl?: string }) | undefined;
    const rawUrl = fastMeta?.rawUrl ?? request.url;
    const path = fastMeta?.path ?? extractPathname(rawUrl);
    const rawMethod = request.method;
    const method =
      rawMethod === 'GET' ||
      rawMethod === 'POST' ||
      rawMethod === 'PUT' ||
      rawMethod === 'DELETE' ||
      rawMethod === 'PATCH' ||
      rawMethod === 'HEAD' ||
      rawMethod === 'OPTIONS'
        ? rawMethod
        : rawMethod.toUpperCase();
    const trustedRequestId = this.trustRequestId
      ? resolveTrustedIncomingRequestId(request, this.requestIdHeader)
      : undefined;

    const ctx = ForgeContextImpl.createFast(
      request,
      method,
      rawUrl,
      path,
      this.ctxConfig,
      fastMeta,
      trustedRequestId,
    );

    let response: Response;

    try {
      let earlyResponse: Response | undefined;
      if (this.hooks.onRequest.length > 0) {
        for (const entry of this.hooks.onRequest) {
          const res = await entry.handler({ ctx });
          if (res instanceof Response) {
            earlyResponse = res;
            break;
          }
        }
      }

      if (earlyResponse !== undefined) {
        response = earlyResponse;
      } else {
        const match = this.router.match(ctx.method, ctx.path);
        if (match.kind === 'not_found') {
          throw new NotFoundError(`Route ${ctx.method} ${ctx.path} not found`);
        }
        if (match.kind === 'method_not_allowed') {
          throw new MethodNotAllowedError(match.allowedMethods, match.allowHeader);
        }

        ctx.setRouteMatch(match.params, match.route.meta);
        const pipeline = this.getRoutePipeline(match.route);
        response = await pipeline(ctx);
      }
    } catch (err: unknown) {
      response = await this.handleError(ctx, err);
    }

    try {
      response = ctx.applyPendingHeaders(response);

      if (this.hooks.onSend.length > 0) {
        for (const entry of this.hooks.onSend) {
          const updated = await entry.handler({ ctx, response });
          if (updated instanceof Response) {
            response = updated;
          }
        }
      }

      response = finalizeHttpSemantics(
        ctx.method,
        response,
        this.requestIdHeader,
        ctx._requestId,
      );
      ctx.markCommitted();
    } catch (sendErr: unknown) {
      response = await this.handleError(ctx, sendErr);
      response = finalizeHttpSemantics(
        ctx.method,
        response,
        this.requestIdHeader,
        ctx._requestId,
      );
      ctx.markCommitted();
    }

    try {
      if (hasOnResponse) {
        const durationMs = Math.max(0, Date.now() - startedAt);
        for (const entry of this.hooks.onResponse) {
          try {
            await entry.handler({
              ctx,
              statusCode: response.status,
              durationMs,
            });
          } catch (hookErr: unknown) {
            ctx.logger.error('Error inside onResponse hook', { error: hookErr });
          }
        }
      }
    } finally {
      const d = ctx.dispose();
      if (d !== undefined) {
        await d;
      }
    }

    return response;
  }
}

export function createHttpApp(options: HttpAppOptions = {}): ForgeHttpApp {
  return new ForgeHttpAppImpl(options);
}
