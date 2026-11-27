import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  FastResponse,
  ForgeHttpError,
  PayloadTooLargeError,
  getFastBody,
  type FetchHandler,
  type HttpRuntimeAdapter,
  type ListenOptions,
  type ServerAddress,
} from '@forge-fr/http';
import { handleNodeWebSocketUpgrade } from './websocket.js';

const SAFE_HOST_REGEX = /^[A-Za-z0-9.\-:\[\]]+$/;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5_000;
const DEFAULT_KEEP_ALIVE_TIMEOUT_MS = 5_000;
const DEFAULT_HEADERS_TIMEOUT_MS = 10_000;

export interface NodeAdapterOptions {
  readonly keepAliveTimeoutMs?: number;
  readonly headersTimeoutMs?: number;
  readonly trustHostHeader?: boolean;
}

interface NodeRequestInit extends RequestInit {
  duplex?: 'half';
}

function sanitizeHost(
  rawHost: string | undefined,
  fallbackHost: string,
  port: number,
  trustHostHeader: boolean,
): string {
  if (trustHostHeader && rawHost && SAFE_HOST_REGEX.test(rawHost)) {
    return rawHost;
  }
  const formattedHost = fallbackHost.includes(':') ? `[${fallbackHost}]` : fallbackHost;
  return `${formattedHost}:${port}`;
}

export class LazyNodeHeaders {
  private readonly req: IncomingMessage;
  private materialized: Headers | null = null;

  public constructor(req: IncomingMessage) {
    this.req = req;
  }

  private ensureMaterialized(): Headers {
    if (this.materialized === null) {
      const h = new Headers();
      const raw = this.req.rawHeaders;
      for (let i = 0; i < raw.length; i += 2) {
        const name = raw[i];
        const value = raw[i + 1];
        if (name !== undefined && value !== undefined) {
          h.append(name, value);
        }
      }
      this.materialized = h;
    }
    return this.materialized;
  }

  public get(name: string): string | null {
    if (this.materialized !== null) {
      return this.materialized.get(name);
    }
    const val = this.req.headers[name.toLowerCase()];
    if (val === undefined) {
      return null;
    }
    return Array.isArray(val) ? val.join(', ') : val;
  }

  public has(name: string): boolean {
    if (this.materialized !== null) {
      return this.materialized.has(name);
    }
    return this.req.headers[name.toLowerCase()] !== undefined;
  }

  public set(name: string, value: string): void {
    this.ensureMaterialized().set(name, value);
  }

  public append(name: string, value: string): void {
    this.ensureMaterialized().append(name, value);
  }

  public delete(name: string): void {
    this.ensureMaterialized().delete(name);
  }

  public forEach(
    callbackfn: (value: string, key: string, parent: Headers) => void,
    thisArg?: unknown,
  ): void {
    this.ensureMaterialized().forEach((val, key) => {
      callbackfn.call(thisArg, val, key, this as unknown as Headers);
    });
  }

  public entries(): HeadersIterator<[string, string]> {
    return this.ensureMaterialized().entries();
  }

  public keys(): HeadersIterator<string> {
    return this.ensureMaterialized().keys();
  }

  public values(): HeadersIterator<string> {
    return this.ensureMaterialized().values();
  }

  public [Symbol.iterator](): HeadersIterator<[string, string]> {
    return this.ensureMaterialized()[Symbol.iterator]();
  }

  public getSetCookie(): string[] {
    if (this.materialized !== null) {
      return this.materialized.getSetCookie();
    }
    const sc = this.req.headers['set-cookie'];
    if (sc === undefined) return [];
    return Array.isArray(sc) ? sc : [sc];
  }
}
Object.setPrototypeOf(LazyNodeHeaders.prototype, Headers.prototype);

function createBoundedNodeBodyStream(
  req: IncomingMessage,
  maxBodyBytes: number | undefined,
): ReadableStream<Uint8Array> {
  let bytesRead = 0;
  let terminated = false;
  let cleanupListeners: (() => void) | null = null;

  return new ReadableStream<Uint8Array>({
    start(controller) {
      const cleanup = (): void => {
        req.off('data', onData);
        req.off('end', onEnd);
        req.off('error', onError);
        req.off('aborted', onAborted);
        cleanupListeners = null;
      };

      const onData = (chunk: Buffer | string): void => {
        if (terminated) return;
        const bytes =
          typeof chunk === 'string'
            ? new TextEncoder().encode(chunk)
            : new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);

        bytesRead += bytes.byteLength;
        if (maxBodyBytes !== undefined && bytesRead > maxBodyBytes) {
          terminated = true;
          cleanup();
          try {
            controller.error(
              new PayloadTooLargeError(
                maxBodyBytes,
                `Request body exceeds adapter limit of ${maxBodyBytes} bytes`,
              ),
            );
          } catch {
            // Stream already closed or errored
          }
          req.resume();
          return;
        }
        try {
          controller.enqueue(bytes);
        } catch {
          terminated = true;
          cleanup();
          req.resume();
        }
      };

      const onEnd = (): void => {
        if (terminated) return;
        terminated = true;
        cleanup();
        try {
          controller.close();
        } catch {
          // Stream already closed or errored
        }
      };

      const onError = (err: Error): void => {
        if (terminated) return;
        terminated = true;
        cleanup();
        try {
          controller.error(err);
        } catch {
          // Stream already closed or errored
        }
      };

      const onAborted = (): void => {
        if (terminated) return;
        terminated = true;
        cleanup();
        try {
          controller.error(new Error('Client aborted request'));
        } catch {
          // Ignore if stream already terminated
        }
      };

      cleanupListeners = cleanup;
      req.on('data', onData);
      req.on('end', onEnd);
      req.on('error', onError);
      req.on('aborted', onAborted);
    },
    cancel() {
      terminated = true;
      cleanupListeners?.();
      req.resume();
    },
  });
}

export class FastNodeRequest {
  public readonly runtime = 'node' as const;
  public readonly path: string;
  public readonly rawUrl: string;
  private readonly _host: string;
  private _fullUrl: string | null = null;
  private readonly _method: string;
  private _headers: LazyNodeHeaders | null = null;
  private readonly req: IncomingMessage;
  private readonly res: ServerResponse;
  private readonly maxBodyBytes?: number | undefined;
  private _signal?: AbortSignal;
  private _abortController?: AbortController;
  private _bodyStream?: ReadableStream<Uint8Array>;
  private _cleanupAbort?: (() => void) | undefined;

  public constructor(
    host: string,
    rawPath: string,
    cleanPath: string,
    method: string,
    req: IncomingMessage,
    res: ServerResponse,
    maxBodyBytes?: number,
  ) {
    this._host = host;
    this.rawUrl = rawPath;
    this.path = cleanPath;
    this._method = method;
    this.req = req;
    this.res = res;
    this.maxBodyBytes = maxBodyBytes;
  }

  public get url(): string {
    if (this._fullUrl === null) {
      this._fullUrl = `http://${this._host}${this.rawUrl}`;
    }
    return this._fullUrl;
  }

  public get method(): string {
    return this._method;
  }

  public get headers(): LazyNodeHeaders {
    if (this._headers === null) {
      this._headers = new LazyNodeHeaders(this.req);
    }
    return this._headers;
  }

  public get remoteAddress(): string | undefined {
    return this.req.socket.remoteAddress;
  }

  public _getHeader(lowerName: string): string | null {
    if (this._headers !== null) {
      return this._headers.get(lowerName);
    }
    const val = this.req.headers[lowerName];
    if (val === undefined) {
      return null;
    }
    return Array.isArray(val) ? val.join(', ') : val;
  }

  public get signal(): AbortSignal {
    if (this._signal === undefined) {
      const ac = new AbortController();
      this._abortController = ac;
      const onDisconnect = (): void => {
        if (!this.res.writableFinished && !ac.signal.aborted) {
          ac.abort();
        }
      };
      this.req.once('aborted', onDisconnect);
      this.res.once('close', onDisconnect);
      this._cleanupAbort = () => {
        this.req.off('aborted', onDisconnect);
        this.res.off('close', onDisconnect);
      };
      this._signal = ac.signal;
    }
    return this._signal;
  }

  public get body(): ReadableStream<Uint8Array> | null {
    if (this._method === 'GET' || this._method === 'HEAD') {
      return null;
    }
    if (this._bodyStream === undefined) {
      this._bodyStream = createBoundedNodeBodyStream(this.req, this.maxBodyBytes);
    }
    return this._bodyStream;
  }

  public get bodyUsed(): boolean {
    return this._bodyUsed || (this._bodyStream !== undefined && this._bodyStream.locked);
  }

  private _bodyUsed = false;

  public _readBoundedText(maxBytes: number): Promise<string> {
    if (this._method === 'GET' || this._method === 'HEAD') {
      return Promise.resolve('');
    }
    if (this._bodyStream !== undefined) {
      return this.text().then((t) => {
        if (Buffer.byteLength(t, 'utf8') > maxBytes) {
          throw new PayloadTooLargeError(maxBytes, `Request body exceeds limit of ${maxBytes} bytes`);
        }
        return t;
      });
    }
    const effectiveLimit =
      this.maxBodyBytes !== undefined && this.maxBodyBytes < maxBytes
        ? this.maxBodyBytes
        : maxBytes;
    this._bodyUsed = true;
    const req = this.req;

    return new Promise<string>((resolve, reject) => {
      let firstChunk: Buffer | null = null;
      let chunks: Buffer[] | null = null;
      let totalBytes = 0;
      let done = false;

      const cleanup = (): void => {
        req.off('data', onData);
        req.off('end', onEnd);
        req.off('error', onError);
        req.off('aborted', onAborted);
      };

      const onData = (chunk: Buffer | string): void => {
        if (done) return;
        const buf = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
        totalBytes += buf.byteLength;
        if (totalBytes > effectiveLimit) {
          done = true;
          cleanup();
          req.resume();
          reject(
            new PayloadTooLargeError(
              effectiveLimit,
              `Request body exceeds limit of ${effectiveLimit} bytes`,
            ),
          );
          return;
        }
        if (firstChunk === null) {
          firstChunk = buf;
        } else if (chunks === null) {
          chunks = [firstChunk, buf];
        } else {
          chunks.push(buf);
        }
      };

      const onEnd = (): void => {
        if (done) return;
        done = true;
        cleanup();
        if (firstChunk === null) {
          resolve('');
        } else if (chunks === null) {
          resolve(firstChunk.toString('utf8'));
        } else {
          resolve(Buffer.concat(chunks, totalBytes).toString('utf8'));
        }
      };

      const onError = (err: Error): void => {
        if (done) return;
        done = true;
        cleanup();
        reject(err);
      };

      const onAborted = (): void => {
        if (done) return;
        done = true;
        cleanup();
        reject(new Error('Client aborted request'));
      };

      req.on('data', onData);
      req.on('end', onEnd);
      req.on('error', onError);
      req.on('aborted', onAborted);
    });
  }

  public async text(): Promise<string> {
    if (this._bodyStream === undefined) {
      return this._readBoundedText(this.maxBodyBytes ?? Number.MAX_SAFE_INTEGER);
    }
    const stream = this.body;
    if (stream === null) return '';
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) chunks.push(value);
    }
    const total = chunks.reduce((acc, c) => acc + c.byteLength, 0);
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const c of chunks) {
      merged.set(c, offset);
      offset += c.byteLength;
    }
    return new TextDecoder().decode(merged);
  }

  public async json<T = unknown>(): Promise<T> {
    const raw = await this.text();
    return JSON.parse(raw);
  }

  public async arrayBuffer(): Promise<ArrayBuffer> {
    const stream = this.body;
    if (stream === null) return new ArrayBuffer(0);
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) chunks.push(value);
    }
    const total = chunks.reduce((acc, c) => acc + c.byteLength, 0);
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const c of chunks) {
      merged.set(c, offset);
      offset += c.byteLength;
    }
    return merged.buffer;
  }

  public cleanup(): void {
    if (this._cleanupAbort !== undefined) {
      this._cleanupAbort();
      this._cleanupAbort = undefined;
    }
  }
}
Object.setPrototypeOf(FastNodeRequest.prototype, Request.prototype);

function waitForDrain(res: ServerResponse): Promise<void> {
  return new Promise<void>((resolve) => {
    const onDone = (): void => {
      res.off('drain', onDone);
      res.off('close', onDone);
      res.off('error', onDone);
      resolve();
    };
    res.once('drain', onDone);
    res.once('close', onDone);
    res.once('error', onDone);
  });
}

const STATIC_JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' };
const STATIC_TEXT_HEADERS = { 'content-type': 'text/plain; charset=utf-8' };
const STATIC_HTML_HEADERS = { 'content-type': 'text/html; charset=utf-8' };

interface NodeHttp1ServerResponse extends ServerResponse {
  _contentLength?: number | null;
  _hasBody?: boolean;
  _removedContLen?: boolean;
}

function trySetNodeContentLength(res: ServerResponse, status: number, length: number): boolean {
  const http1 = res as NodeHttp1ServerResponse;
  if (
    http1._contentLength === null &&
    http1._hasBody === true &&
    res.useChunkedEncodingByDefault &&
    !http1._removedContLen &&
    status >= 200 &&
    status !== 204 &&
    status !== 304 &&
    !res.hasHeader('content-length') &&
    !res.hasHeader('transfer-encoding')
  ) {
    http1._contentLength = length;
    return true;
  }
  return false;
}

function writeFastResponseSync(
  req: IncomingMessage,
  res: ServerResponse,
  webResponse: FastResponse,
  requestMethod: string,
): void {
  if (res.destroyed || res.writableEnded) {
    return;
  }

  const fh = webResponse._fastHeaders;
  const status = webResponse._status;
  const rawBody = webResponse._rawBody;

  // Fast path: static single-header response (no custom headers, no cookies, no requestId)
  if (
    fh === null &&
    typeof rawBody === 'string' &&
    requestMethod !== 'HEAD' &&
    status !== 204 &&
    status !== 304 &&
    (requestMethod === 'GET' || req.complete)
  ) {
    const ct = webResponse._contentType ?? 'application/json; charset=utf-8';
    const len = Buffer.byteLength(rawBody, 'utf8');
    if (trySetNodeContentLength(res, status, len)) {
      const staticHeaders =
        ct === 'application/json; charset=utf-8'
          ? STATIC_JSON_HEADERS
          : ct === 'text/plain; charset=utf-8'
            ? STATIC_TEXT_HEADERS
            : ct === 'text/html; charset=utf-8'
              ? STATIC_HTML_HEADERS
              : { 'content-type': ct };
      res.writeHead(status, staticHeaders);
    } else {
      res.writeHead(status, {
        'content-type': ct,
        'content-length': len,
      });
    }
    res.end(rawBody);
    return;
  }

  if (fh === null) {
    if (webResponse._contentType !== null) {
      res.setHeader('content-type', webResponse._contentType);
    }
  } else {
    const map = fh._map;
    for (const key in map) {
      const val = map[key];
      if (val !== undefined) {
        res.setHeader(key, val);
      }
    }
    if (fh._setCookies !== null && fh._setCookies.length > 0) {
      res.setHeader('set-cookie', fh._setCookies);
    }
  }

  if (requestMethod !== 'GET' && requestMethod !== 'HEAD' && !req.complete) {
    res.setHeader('connection', 'close');
  }

  res.statusCode = status;

  const isNoBody =
    requestMethod === 'HEAD' || status === 204 || status === 304 || rawBody === null;

  if (isNoBody) {
    res.end();
    return;
  }

  if (typeof rawBody === 'string') {
    if (fh === null || fh._map['content-length'] === undefined) {
      res.setHeader('content-length', Buffer.byteLength(rawBody, 'utf8'));
    }
    res.end(rawBody, 'utf8');
    return;
  }

  const payload = Buffer.from(rawBody.buffer, rawBody.byteOffset, rawBody.byteLength);
  if (fh === null || fh._map['content-length'] === undefined) {
    res.setHeader('content-length', payload.byteLength);
  }
  res.end(payload);
}

async function writeWebResponse(
  req: IncomingMessage,
  res: ServerResponse,
  webResponse: Response,
  requestMethod: string,
): Promise<void> {
  if (webResponse instanceof FastResponse) {
    writeFastResponseSync(req, res, webResponse, requestMethod);
    return;
  }

  if (res.destroyed || res.writableEnded) {
    if (webResponse.body !== null) {
      webResponse.body.cancel().catch(() => {});
    }
    return;
  }

  const setCookies =
    typeof webResponse.headers.getSetCookie === 'function'
      ? webResponse.headers.getSetCookie()
      : [];

  for (const [key, value] of webResponse.headers.entries()) {
    if (key.toLowerCase() === 'set-cookie') {
      continue;
    }
    res.setHeader(key, value);
  }
  if (setCookies.length > 0) {
    res.setHeader('set-cookie', setCookies);
  }

  // Prevent keep-alive socket desync / request smuggling when returning early before body completes
  if (requestMethod !== 'GET' && requestMethod !== 'HEAD' && !req.complete) {
    res.setHeader('connection', 'close');
  }

  res.statusCode = webResponse.status;
  if (webResponse.statusText) {
    res.statusMessage = webResponse.statusText;
  }

  const fastBody = getFastBody(webResponse);
  const isNoBodyStatus =
    requestMethod === 'HEAD' ||
    webResponse.status === 204 ||
    webResponse.status === 304;

  if (isNoBodyStatus || (fastBody === undefined && webResponse.body === null)) {
    if (fastBody === undefined && webResponse.body !== null) {
      webResponse.body.cancel().catch(() => {});
    }
    res.end();
    return;
  }

  if (fastBody !== undefined) {
    if (typeof fastBody === 'string') {
      const byteLen = Buffer.byteLength(fastBody, 'utf8');
      if (!res.hasHeader('content-length')) {
        res.setHeader('content-length', byteLen);
      }
      res.end(fastBody, 'utf8');
      return;
    }
    const payload = Buffer.from(fastBody.buffer, fastBody.byteOffset, fastBody.byteLength);
    if (!res.hasHeader('content-length')) {
      res.setHeader('content-length', payload.byteLength);
    }
    res.end(payload);
    return;
  }

  const bodyStream = webResponse.body;
  if (bodyStream === null) {
    res.end();
    return;
  }

  res.flushHeaders();
  const reader = bodyStream.getReader();

  const onClose = (): void => {
    reader.cancel().catch(() => {});
  };
  res.once('close', onClose);

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (res.destroyed || res.writableEnded) {
        await reader.cancel();
        break;
      }
      if (value && value.byteLength > 0) {
        const canContinue = res.write(value);
        if (!canContinue) {
          await waitForDrain(res);
        }
      }
    }
  } finally {
    res.off('close', onClose);
    reader.releaseLock();
    if (!res.destroyed && !res.writableEnded) {
      res.end();
    }
  }
}

export class NodeAdapter implements HttpRuntimeAdapter {
  public readonly name = 'node';
  public readonly runtime = 'node' as const;

  private readonly keepAliveTimeoutMs: number;
  private readonly headersTimeoutMs: number;
  private readonly trustHostHeader: boolean;

  private server: Server | null = null;
  private activeAddress: ServerAddress | null = null;
  private inFlightCount = 0;
  private onDrained: (() => void) | null = null;
  private readonly activeWebSockets = new Set<(code?: number, reason?: string) => void>();
  private closing = false;
  private shutdownAbortCleanup: (() => void) | null = null;

  private defaultHost = '127.0.0.1:80';

  public constructor(options: NodeAdapterOptions = {}) {
    this.keepAliveTimeoutMs = options.keepAliveTimeoutMs ?? DEFAULT_KEEP_ALIVE_TIMEOUT_MS;
    this.headersTimeoutMs = options.headersTimeoutMs ?? DEFAULT_HEADERS_TIMEOUT_MS;
    this.trustHostHeader = options.trustHostHeader ?? false;
  }

  public get isListening(): boolean {
    return this.server !== null && !this.closing;
  }

  public get address(): ServerAddress | null {
    return this.activeAddress;
  }

  public async listen(handler: FetchHandler, options: ListenOptions): Promise<ServerAddress> {
    if (this.server !== null) {
      throw new ForgeHttpError('NodeAdapter is already listening', {
        code: 'ADAPTER_ALREADY_LISTENING',
        statusCode: 500,
        expose: false,
      });
    }

    const bindHost = options.host ?? '127.0.0.1';
    const maxBodyBytes = options.maxBodyBytes;
    const defaultShutdownTimeout = options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
    this.closing = false;

    const server = createServer((req, res) => {
      this.handleIncoming(req, res, handler, bindHost, maxBodyBytes);
    });

    server.keepAliveTimeout = this.keepAliveTimeoutMs;
    server.headersTimeout = this.headersTimeoutMs;
    if (options.requestTimeoutMs !== undefined) {
      server.requestTimeout = options.requestTimeoutMs;
    }

    server.on('upgrade', (req, socket, head) => {
      const boundPort = this.activeAddress?.port ?? options.port;
      void handleNodeWebSocketUpgrade({
        req,
        socket,
        head,
        handler,
        bindHost,
        port: boundPort,
        trustHostHeader: this.trustHostHeader,
        activeSockets: this.activeWebSockets,
      });
    });

    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error): void => {
        server.off('listening', onListening);
        reject(err);
      };
      const onListening = (): void => {
        server.off('error', onError);
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(options.port, bindHost);
    });

    const rawAddr = server.address() as AddressInfo | null;
    const boundPort = rawAddr?.port ?? options.port;
    const formattedHost = bindHost.includes(':') ? `[${bindHost}]` : bindHost;
    this.defaultHost = `${formattedHost}:${boundPort}`;

    this.server = server;
    this.activeAddress = {
      host: bindHost,
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

  private handleIncoming(
    req: IncomingMessage,
    res: ServerResponse,
    handler: FetchHandler,
    bindHost: string,
    maxBodyBytes: number | undefined,
  ): void {
    const rawMethod = req.method ?? 'GET';
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
    const host = this.trustHostHeader
      ? sanitizeHost(req.headers.host, bindHost, this.activeAddress?.port ?? 80, true)
      : this.defaultHost;
    const reqUrl = req.url ?? '/';
    const rawPath = reqUrl.charCodeAt(0) === 47 ? reqUrl : `/${reqUrl}`;
    const qIdx = rawPath.indexOf('?');
    const cleanPath = qIdx === -1 ? rawPath : rawPath.slice(0, qIdx);

    // Fast-fail on oversized declared Content-Length at the adapter boundary
    if (maxBodyBytes !== undefined) {
      const contentLengthHeader = req.headers['content-length'];
      if (contentLengthHeader !== undefined) {
        const declared = Number(contentLengthHeader);
        if (Number.isFinite(declared) && declared > maxBodyBytes) {
          const body = JSON.stringify({
            error: {
              code: 'PAYLOAD_TOO_LARGE',
              message: `Request body exceeds limit of ${maxBodyBytes} bytes`,
            },
          });
          res.statusCode = 413;
          res.setHeader('content-type', 'application/json; charset=utf-8');
          res.setHeader('connection', 'close');
          res.end(body);
          req.resume();
          return;
        }
      }
    }

    const webRequest = new FastNodeRequest(
      host,
      rawPath,
      cleanPath,
      method,
      req,
      res,
      maxBodyBytes,
    );

    try {
      const resOrPromise = handler(
        webRequest as unknown as Request,
        webRequest,
      );

      if (resOrPromise instanceof FastResponse) {
        writeFastResponseSync(req, res, resOrPromise, method);
        webRequest.cleanup();
        return;
      }

      this.inFlightCount += 1;
      void this.completeAsyncIncoming(req, res, webRequest, resOrPromise, method);
    } catch {
      this.writeFallback500(res);
      webRequest.cleanup();
    }
  }

  private writeFallback500(res: ServerResponse): void {
    if (!res.destroyed && !res.writableEnded) {
      if (!res.headersSent) {
        res.statusCode = 500;
        res.setHeader('content-type', 'application/json; charset=utf-8');
        res.end(
          JSON.stringify({
            error: {
              code: 'INTERNAL_ERROR',
              message: 'Internal Server Error',
            },
          }),
        );
      } else {
        res.end();
      }
    }
  }

  private async completeAsyncIncoming(
    req: IncomingMessage,
    res: ServerResponse,
    webRequest: FastNodeRequest,
    resOrPromise: Promise<Response> | Response,
    method: string,
  ): Promise<void> {
    try {
      const webResponse = resOrPromise instanceof Promise ? await resOrPromise : resOrPromise;
      await writeWebResponse(req, res, webResponse, method);
    } catch {
      this.writeFallback500(res);
    } finally {
      webRequest.cleanup();
      this.inFlightCount -= 1;
      if (this.closing && this.inFlightCount === 0 && this.onDrained !== null) {
        this.onDrained();
        this.onDrained = null;
      }
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

    for (const closeWs of Array.from(this.activeWebSockets)) {
      closeWs(1001, 'Server shutting down');
    }

    const closeDone = new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });

    if (typeof server.closeIdleConnections === 'function') {
      server.closeIdleConnections();
    }

    let timer: ReturnType<typeof setTimeout> | undefined;
    const drainPromise = (
      this.inFlightCount === 0
        ? Promise.resolve()
        : new Promise<void>((resolve) => {
            this.onDrained = resolve;
            if (this.inFlightCount === 0) {
              resolve();
              this.onDrained = null;
            }
          })
    ).then(() => {
      if (typeof server.closeIdleConnections === 'function') {
        server.closeIdleConnections();
      }
    });

    const timeoutPromise = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        if (typeof server.closeAllConnections === 'function') {
          server.closeAllConnections();
        }
        resolve();
      }, Math.max(0, timeoutMs));
    });

    await Promise.race([Promise.all([drainPromise, closeDone]), timeoutPromise]);
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    this.closing = false;
  }
}

export function createNodeAdapter(options?: NodeAdapterOptions): NodeAdapter {
  return new NodeAdapter(options);
}
