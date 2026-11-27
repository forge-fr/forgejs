import type { Container, ForgeLogger, InjectionToken } from '@forge-fr/core';
import {
  DEFAULT_MAX_BODY_BYTES,
   type FastBoundedTextRequest,
  hasForbiddenKey,
  readBoundedBytes,
  readBoundedJson,
  readBoundedMultipart,
  readBoundedText,
  readBoundedUrlEncoded,
  stripForbiddenKeys,
} from './body.js';
import { BadRequestError, ResponseCommittedError } from './errors.js';
import {
  FastResponse,
  copyFastBody,
  createFastResponse,
  createFastStaticResponse,
} from './fast-body.js';
import { negotiateContentType } from './negotiation.js';
import { createSseResponse } from './sse.js';
import type {
  BodyParseOptions,
  ForgeContext,
  MultipartParseOptions,
  ParsedMultipart,
  RedirectStatusCode,
  RequestBodyReader,
  ResponseHelperInit,
  RuntimeRequestMeta,
  SseProducer,
} from './types.js';

const FORBIDDEN_QUERY_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const EMPTY_QUERY: Readonly<Record<string, string>> = Object.freeze(
  Object.create(null) as Record<string, string>,
);
const EMPTY_PARAMS: Readonly<Record<string, string>> = Object.freeze(
  Object.create(null) as Record<string, string>,
);
const EMPTY_META: Readonly<Record<string, unknown>> = Object.freeze({});
const VALID_HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const INVALID_HEADER_VALUE = /[\r\n\0]/;
const VALID_REDIRECT_STATUSES = new Set<number>([301, 302, 303, 307, 308]);

type HeaderOp =
  | { readonly kind: 'set'; readonly name: string; readonly value: string }
  | { readonly kind: 'append'; readonly name: string; readonly value: string }
  | { readonly kind: 'delete'; readonly name: string };

function assertValidHeaderName(name: string): void {
  if (!VALID_HEADER_NAME.test(name)) {
    throw new BadRequestError(`Invalid HTTP header name "${name}"`);
  }
}

function assertValidHeaderValue(name: string, value: string): void {
  if (INVALID_HEADER_VALUE.test(value)) {
    throw new BadRequestError(`Invalid HTTP header value for "${name}"`);
  }
}

export function extractPathname(rawUrl: string): string {
  const firstChar = rawUrl.charCodeAt(0);
  let pathStart = 0;
  if (firstChar !== 47 /* '/' */) {
    // Fast path for standard http:// or https:// URLs
    const slashAfterHost = rawUrl.indexOf('/', 8);
    if (slashAfterHost === -1) {
      return '/';
    }
    pathStart = slashAfterHost;
  }

  let end = rawUrl.indexOf('?', pathStart);
  if (end === -1) {
    end = rawUrl.length;
  }
  const hIdx = rawUrl.indexOf('#', pathStart);
  if (hIdx !== -1 && hIdx < end) {
    end = hIdx;
  }
  if (pathStart === 0 && end === rawUrl.length) {
    return rawUrl.length === 0 ? '/' : rawUrl;
  }
  const sliced = rawUrl.slice(pathStart, end);
  return sliced.length === 0 ? '/' : sliced;
}

export function extractQueryString(rawUrl: string): string {
  const qIdx = rawUrl.indexOf('?');
  if (qIdx === -1) return '';
  const hIdx = rawUrl.indexOf('#', qIdx + 1);
  return hIdx === -1 ? rawUrl.slice(qIdx + 1) : rawUrl.slice(qIdx + 1, hIdx);
}

export function parseRequestUrl(rawUrl: string): URL {
  if (rawUrl.charCodeAt(0) === 47 /* '/' */) {
    return new URL(rawUrl, 'http://localhost');
  }
  try {
    return new URL(rawUrl);
  } catch {
    return new URL(`/${rawUrl}`, 'http://localhost');
  }
}

function buildSafeQuery(rawUrl: string, existingUrl?: URL): Readonly<Record<string, string>> {
  if (existingUrl !== undefined) {
    if (!existingUrl.search || existingUrl.search === '?') {
      return EMPTY_QUERY;
    }
    const query: Record<string, string> = Object.create(null) as Record<string, string>;
    for (const [key, value] of existingUrl.searchParams.entries()) {
      if (FORBIDDEN_QUERY_KEYS.has(key)) {
        continue;
      }
      if (query[key] === undefined) {
        query[key] = value;
      }
    }
    return Object.freeze(query);
  }

  const search = extractQueryString(rawUrl);
  if (search.length === 0) {
    return EMPTY_QUERY;
  }

  // Fast path for unencoded query strings without '%' or '+'
  if (search.indexOf('%') === -1 && search.indexOf('+') === -1) {
    const query: Record<string, string> = Object.create(null) as Record<string, string>;
    let start = 0;
    const len = search.length;
    while (start < len) {
      let amp = search.indexOf('&', start);
      if (amp === -1) amp = len;
      if (amp > start) {
        const eq = search.indexOf('=', start);
        let key: string;
        let val: string;
        if (eq === -1 || eq > amp) {
          key = search.slice(start, amp);
          val = '';
        } else {
          key = search.slice(start, eq);
          val = search.slice(eq + 1, amp);
        }
        if (key.length > 0 && !FORBIDDEN_QUERY_KEYS.has(key) && query[key] === undefined) {
          query[key] = val;
        }
      }
      start = amp + 1;
    }
    return query;
  }

  const query: Record<string, string> = Object.create(null) as Record<string, string>;
  const params = new URLSearchParams(search);
  for (const [key, value] of params.entries()) {
    if (FORBIDDEN_QUERY_KEYS.has(key)) {
      continue;
    }
    if (query[key] === undefined) {
      query[key] = value;
    }
  }
  return Object.freeze(query);
}

export interface CreateContextOptions {
  readonly request: Request;
  readonly url?: URL;
  readonly rawUrl?: string;
  readonly path?: string;
  readonly headers?: Headers;
  readonly requestId?: string;
  readonly requestIdFactory?: () => string;
  readonly requestIdHeader?: string;
  readonly remoteAddress?: string | undefined;
  readonly remoteAddressSource?: { readonly remoteAddress?: string | undefined };
  readonly runtime: string;
  readonly logger: ForgeLogger | (() => ForgeLogger);
  readonly maxBodyBytes?: number;
  readonly createRequestScope: () => Container;
  readonly externalSignal?: AbortSignal;
}

export interface ContextAppConfig {
  readonly defaultRuntime: string;
  readonly requestIdHeader: string;
  readonly requestIdFactory: (() => string) | undefined;
  readonly logger: ForgeLogger | (() => ForgeLogger);
  readonly createRequestScope: () => Container;
  readonly defaultMaxBytes: number;
}

export interface ContextColdState {
  urlInstance: URL | undefined;
  headersInstance: Headers | undefined;
  initialHeaders: Headers | undefined;
  loggerInstance: ForgeLogger | undefined;
  bodyReader: RequestBodyReader | undefined;
  abortController: AbortController | null;
  externalSignal: AbortSignal | undefined;
  onExternalAbort: (() => void) | undefined;
  requestScope: Container | null;
  headerOps: HeaderOp[] | null;
  appliedHeaderOpCount: number;
  remoteAddress: string | undefined;
  remoteAddressResolved: boolean;
  remoteAddressSource: { readonly remoteAddress?: string | undefined } | undefined;
}

export interface FastHeaderMeta extends RuntimeRequestMeta {
  _getHeader?(lowerName: string): string | null;
  requestIP?(req: Request): { readonly address?: string } | null;
}

export class ForgeContextImpl implements ForgeContext {
  public readonly request: Request;
  public readonly method: string;
  public readonly path: string;
  private readonly rawUrl: string;
  private readonly _cfg: ContextAppConfig;
  private readonly _meta: FastHeaderMeta | undefined;
  public _requestId: string | undefined;
  public _params: Readonly<Record<string, string>> = EMPTY_PARAMS;
  public _routeMeta: Readonly<Record<string, unknown>> = EMPTY_META;
  private _queryRecord: Readonly<Record<string, string>> | undefined = undefined;
  private stateObj: Record<string, unknown> | null = null;
  public _validated: unknown = undefined;
  private stagedStatus = 200;
  private _committed = false;
  public _cold: ContextColdState | null = null;

  public constructor(
    optionsOrReq: CreateContextOptions | Request,
    fastMethod?: string,
    fastRawUrl?: string,
    fastPath?: string,
    fastCfg?: ContextAppConfig,
    fastMeta?: FastHeaderMeta,
    fastTrustedReqId?: string,
  ) {
    if (fastCfg !== undefined) {
      const req = optionsOrReq as Request;
      this.request = req;
      this.method = fastMethod!;
      this.rawUrl = fastRawUrl!;
      this.path = fastPath!;
      this._cfg = fastCfg;
      this._meta = fastMeta;
      this._requestId = fastTrustedReqId;
      return;
    }

    const options = optionsOrReq as CreateContextOptions;
    this.request = options.request;
    const m = options.request.method;
    this.method =
      m === 'GET' || m === 'POST' || m === 'PUT' || m === 'DELETE' || m === 'PATCH' || m === 'HEAD' || m === 'OPTIONS'
        ? m
        : m.toUpperCase();
    this.rawUrl = options.rawUrl ?? options.request.url;
    this.path =
      options.path ??
      (options.url !== undefined ? options.url.pathname : extractPathname(this.rawUrl));
    this._cfg = {
      defaultRuntime: options.runtime,
      requestIdHeader: options.requestIdHeader ?? 'x-request-id',
      requestIdFactory: options.requestIdFactory,
      logger: options.logger,
      createRequestScope: options.createRequestScope,
      defaultMaxBytes: options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES,
    };
    this._meta = undefined;
    this._requestId = options.requestId;

    if (
      options.url !== undefined ||
      options.headers !== undefined ||
      options.remoteAddress !== undefined ||
      options.remoteAddressSource !== undefined ||
      options.externalSignal !== undefined
    ) {
      this._cold = {
        urlInstance: options.url,
        headersInstance: undefined,
        initialHeaders: options.headers,
        loggerInstance: undefined,
        bodyReader: undefined,
        abortController: null,
        externalSignal: options.externalSignal,
        onExternalAbort: undefined,
        requestScope: null,
        headerOps: null,
        appliedHeaderOpCount: 0,
        remoteAddress: options.remoteAddress,
        remoteAddressResolved: options.remoteAddress !== undefined,
        remoteAddressSource: options.remoteAddressSource,
      };
    }
  }

  public static createFast(
    request: Request,
    method: string,
    rawUrl: string,
    path: string,
    cfg: ContextAppConfig,
    meta: FastHeaderMeta | undefined,
    trustedRequestId: string | undefined,
  ): ForgeContextImpl {
    return new ForgeContextImpl(
      request,
      method,
      rawUrl,
      path,
      cfg,
      meta,
      trustedRequestId,
    );
  }

  private ensureCold(): ContextColdState {
    if (this._cold === null) {
      this._cold = {
        urlInstance: undefined,
        headersInstance: undefined,
        initialHeaders: this._meta?.headers,
        loggerInstance: undefined,
        bodyReader: undefined,
        abortController: null,
        externalSignal: this._meta?.signal,
        onExternalAbort: undefined,
        requestScope: null,
        headerOps: null,
        appliedHeaderOpCount: 0,
        remoteAddress: undefined,
        remoteAddressResolved: false,
        remoteAddressSource: this._meta,
      };
    }
    return this._cold;
  }

  public get runtime(): string {
    return this._meta?.runtime ?? this._cfg.defaultRuntime;
  }

  public get remoteAddress(): string | undefined {
    const cold = this.ensureCold();
    if (!cold.remoteAddressResolved) {
      cold.remoteAddressResolved = true;
      const meta = this._meta;
      if (meta !== undefined && typeof meta.requestIP === 'function') {
        cold.remoteAddress = meta.requestIP(this.request)?.address;
      } else {
        cold.remoteAddress = (cold.remoteAddressSource ?? meta)?.remoteAddress;
      }
    }
    return cold.remoteAddress;
  }

  public get requestId(): string {
    if (this._requestId === undefined) {
      const factory = this._cfg.requestIdFactory;
      this._requestId = factory !== undefined ? factory() : 'req-0';
    }
    return this._requestId;
  }

  public get url(): URL {
    const cold = this.ensureCold();
    if (cold.urlInstance === undefined) {
      cold.urlInstance = parseRequestUrl(
        this.rawUrl.charCodeAt(0) === 47 ? this.request.url : this.rawUrl,
      );
    }
    return cold.urlInstance;
  }

  public get headers(): Headers {
    const cold = this.ensureCold();
    if (cold.headersInstance === undefined) {
      cold.headersInstance = cold.initialHeaders ?? this._meta?.headers ?? this.request.headers;
    }
    return cold.headersInstance;
  }

  public get query(): Readonly<Record<string, string>> {
    if (this._queryRecord === undefined) {
      this._queryRecord = buildSafeQuery(this.rawUrl, this._cold?.urlInstance);
    }
    return this._queryRecord;
  }

  public get logger(): ForgeLogger {
    const cold = this.ensureCold();
    if (cold.loggerInstance === undefined) {
      const loggerOrFactory = this._cfg.logger;
      const base =
        typeof loggerOrFactory === 'function' ? loggerOrFactory() : loggerOrFactory;
      cold.loggerInstance = base.child({ requestId: this.requestId });
    }
    return cold.loggerInstance;
  }

  public get body(): RequestBodyReader {
    const cold = this.ensureCold();
    if (cold.bodyReader === undefined) {
      const defaultMaxBytes = this._cfg.defaultMaxBytes;
      cold.bodyReader = {
        bytes: (opts?: Pick<BodyParseOptions, 'maxBytes'>) =>
          readBoundedBytes(this.request, opts?.maxBytes ?? defaultMaxBytes),
        arrayBuffer: async (opts?: Pick<BodyParseOptions, 'maxBytes'>) => {
          const buf = await readBoundedBytes(this.request, opts?.maxBytes ?? defaultMaxBytes);
          const copy = new Uint8Array(buf.byteLength);
          copy.set(buf);
          return copy.buffer;
        },
        text: (opts?: Pick<BodyParseOptions, 'maxBytes'>) =>
          readBoundedText(this.request, { maxBytes: opts?.maxBytes ?? defaultMaxBytes }),
        json: <T = unknown>(opts?: BodyParseOptions) =>
          readBoundedJson<T>(this.request, {
            ...opts,
            maxBytes: opts?.maxBytes ?? defaultMaxBytes,
          }),
        form: (opts?: Pick<BodyParseOptions, 'maxBytes'>) =>
          readBoundedUrlEncoded(this.request, { maxBytes: opts?.maxBytes ?? defaultMaxBytes }),
        multipart: (opts?: MultipartParseOptions): Promise<ParsedMultipart> =>
          readBoundedMultipart(this.request, {
            ...opts,
            maxBytes: opts?.maxBytes ?? defaultMaxBytes,
          }),
      };
    }
    return cold.bodyReader;
  }

  public _readValidationBody(options: {
    readonly maxBodyBytes?: number;
    readonly allowProtoKeys?: boolean;
  }): Promise<unknown> {
    const limit = options.maxBodyBytes ?? this._cfg.defaultMaxBytes;
    const fastReq = this.request as unknown as FastBoundedTextRequest;

    if (typeof fastReq._readBoundedText === 'function') {
      const rawCt = this.header('content-type');
      if (
        rawCt !== null &&
        (rawCt === 'application/x-www-form-urlencoded' ||
          rawCt.startsWith('application/x-www-form-urlencoded;'))
      ) {
        return readBoundedUrlEncoded(this.request, { maxBytes: limit });
      }
      return fastReq._readBoundedText(limit).then((rawText) => {
        if (
          rawText.length === 0 ||
          (rawText.charCodeAt(0) <= 32 && rawText.trim().length === 0)
        ) {
          throw new BadRequestError('Request body is empty; expected valid JSON');
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(rawText);
        } catch (err: unknown) {
          throw new BadRequestError('Malformed JSON request body', { cause: err });
        }
        if (options.allowProtoKeys === true || !hasForbiddenKey(parsed)) {
          return parsed;
        }
        return stripForbiddenKeys(parsed);
      });
    }

    if (limit >= DEFAULT_MAX_BODY_BYTES) {
      const contentLengthHeader = this.header('content-length');
      if (contentLengthHeader !== null) {
        const declaredLength = Number(contentLengthHeader);
        if (Number.isFinite(declaredLength) && declaredLength <= limit) {
          return this.request.json().then(
            (parsed: unknown) => {
              if (options.allowProtoKeys === true || !hasForbiddenKey(parsed)) {
                return parsed;
              }
              return stripForbiddenKeys(parsed);
            },
            (err: unknown) => {
              const rawCt = this.header('content-type');
              if (
                rawCt !== null &&
                (rawCt === 'application/x-www-form-urlencoded' ||
                  rawCt.startsWith('application/x-www-form-urlencoded;'))
              ) {
                return readBoundedUrlEncoded(this.request, { maxBytes: limit });
              }
              throw new BadRequestError('Malformed JSON request body', { cause: err });
            },
          );
        }
      }
    }

    const rawCt = this.header('content-type');
    if (
      rawCt !== null &&
      (rawCt === 'application/x-www-form-urlencoded' ||
        rawCt.startsWith('application/x-www-form-urlencoded;'))
    ) {
      return readBoundedUrlEncoded(this.request, { maxBytes: limit });
    }
    return readBoundedJson(this.request, {
      maxBytes: limit,
      ...(options.allowProtoKeys !== undefined ? { allowProtoKeys: options.allowProtoKeys } : {}),
    });
  }

  public get params(): Readonly<Record<string, string>> {
    return this._params;
  }

  public get routeMeta(): Readonly<Record<string, unknown>> {
    return this._routeMeta;
  }

  public get signal(): AbortSignal {
    const cold = this.ensureCold();
    if (cold.abortController === null) {
      const controller = new AbortController();
      const parent = cold.externalSignal ?? this.request.signal;
      if (parent) {
        if (parent.aborted) {
          controller.abort(parent.reason);
        } else {
          cold.onExternalAbort = () => {
            controller.abort(parent.reason);
          };
          parent.addEventListener('abort', cold.onExternalAbort, { once: true });
        }
      }
      cold.abortController = controller;
    }
    return cold.abortController.signal;
  }

  public get committed(): boolean {
    return this._committed;
  }

  public get container(): Container {
    const cold = this.ensureCold();
    if (cold.requestScope === null) {
      cold.requestScope = this._cfg.createRequestScope();
    }
    return cold.requestScope;
  }

  public setRouteMatch(
    params: Readonly<Record<string, string>>,
    meta: Readonly<Record<string, unknown>>,
  ): void {
    this._params = params;
    this._routeMeta = meta;
  }

  public header(name: string): string | null {
    const cold = this._cold;
    if (cold !== null) {
      if (cold.headersInstance !== undefined) {
        return cold.headersInstance.get(name);
      }
      if (cold.initialHeaders !== undefined) {
        return cold.initialHeaders.get(name);
      }
    }
    const meta = this._meta;
    if (meta !== undefined && typeof meta._getHeader === 'function') {
      return meta._getHeader(name.toLowerCase());
    }
    return this.request.headers.get(name);
  }

  public queryAll(name: string): readonly string[] {
    if (FORBIDDEN_QUERY_KEYS.has(name)) {
      return [];
    }
    if (this._cold?.urlInstance !== undefined) {
      return this._cold.urlInstance.searchParams.getAll(name);
    }
    const search = extractQueryString(this.rawUrl);
    if (search.length === 0) {
      return [];
    }
    return new URLSearchParams(search).getAll(name);
  }

  public accepts(offered: readonly string[]): string | null {
    return negotiateContentType(this.header('accept'), offered);
  }

  public resolve<T>(token: InjectionToken<T>): T {
    return this.container.resolve(token);
  }

  public resolveOptional<T>(token: InjectionToken<T>): T | undefined {
    return this.container.resolveOptional(token);
  }

  public getState<T = unknown>(key: string): T | undefined {
    return this.stateObj !== null ? (this.stateObj[key] as T | undefined) : undefined;
  }

  public setState<T = unknown>(key: string, value: T): this {
    if (this.stateObj === null) {
      this.stateObj = Object.create(null) as Record<string, unknown>;
    }
    this.stateObj[key] = value;
    return this;
  }

  public hasState(key: string): boolean {
    return this.stateObj !== null && key in this.stateObj;
  }

  private assertNotCommitted(): void {
    if (this._committed) {
      throw new ResponseCommittedError();
    }
  }

  public status(code: number): this {
    this.assertNotCommitted();
    if (!Number.isInteger(code) || code < 100 || code > 599) {
      throw new BadRequestError(`Invalid HTTP status code: ${code}`);
    }
    this.stagedStatus = code;
    return this;
  }

  private pushHeaderOp(op: HeaderOp): void {
    const cold = this.ensureCold();
    if (cold.headerOps === null) {
      cold.headerOps = [];
    }
    cold.headerOps.push(op);
  }

  public setHeader(name: string, value: string): this {
    this.assertNotCommitted();
    assertValidHeaderName(name);
    assertValidHeaderValue(name, value);
    this.pushHeaderOp({ kind: 'set', name, value });
    return this;
  }

  public appendHeader(name: string, value: string): this {
    this.assertNotCommitted();
    assertValidHeaderName(name);
    assertValidHeaderValue(name, value);
    this.pushHeaderOp({ kind: 'append', name, value });
    return this;
  }

  public removeHeader(name: string): this {
    this.assertNotCommitted();
    assertValidHeaderName(name);
    this.pushHeaderOp({ kind: 'delete', name });
    return this;
  }

  private buildHeaderRecord(
    initHeaders?: HeadersInit,
    defaultContentType?: string,
  ): { record: Record<string, string>; setCookies: string[] | null } {
    const record: Record<string, string> = Object.create(null) as Record<string, string>;
    let setCookies: string[] | null = null;
    const cold = this._cold;
    const headerOps = cold !== null ? cold.headerOps : null;

    if (headerOps === null && initHeaders === undefined) {
      if (defaultContentType !== undefined) {
        record['content-type'] = defaultContentType;
      }
      if (this._requestId !== undefined) {
        record[this._cfg.requestIdHeader] = this._requestId;
      }
      return { record, setCookies };
    }

    if (headerOps !== null && cold !== null) {
      for (let i = 0; i < headerOps.length; i += 1) {
        const op: HeaderOp | undefined = headerOps[i];
        if (!op) continue;
        const k = op.name.toLowerCase();
        if (op.kind === 'set') {
          if (k === 'set-cookie') {
            setCookies = [op.value];
          } else {
            record[k] = op.value;
          }
        } else if (op.kind === 'append') {
          if (k === 'set-cookie') {
            if (setCookies === null) setCookies = [];
            setCookies.push(op.value);
          } else {
            const existing = record[k];
            record[k] = existing !== undefined ? `${existing}, ${op.value}` : op.value;
          }
        } else {
          if (k === 'set-cookie') {
            setCookies = null;
          } else {
            delete record[k];
          }
        }
      }
      cold.appliedHeaderOpCount = headerOps.length;
    }

    if (initHeaders !== undefined) {
      if (initHeaders instanceof Headers) {
        const sc =
          typeof initHeaders.getSetCookie === 'function' ? initHeaders.getSetCookie() : [];
        for (const [k, v] of initHeaders.entries()) {
          const lower = k.toLowerCase();
          if (lower === 'set-cookie') continue;
          record[lower] = v;
        }
        if (sc.length > 0) {
          if (setCookies === null) setCookies = [];
          setCookies.push(...sc);
        }
      } else if (Array.isArray(initHeaders)) {
        for (let i = 0; i < initHeaders.length; i += 1) {
          const pair = initHeaders[i];
          if (!pair) continue;
          const lower = pair[0].toLowerCase();
          if (lower === 'set-cookie') {
            if (setCookies === null) setCookies = [];
            setCookies.push(pair[1]);
          } else {
            record[lower] = pair[1];
          }
        }
      } else {
        for (const [k, v] of Object.entries(initHeaders)) {
          if (v === undefined) continue;
          const lower = k.toLowerCase();
          if (lower === 'set-cookie') {
            if (setCookies === null) setCookies = [];
            setCookies.push(String(v));
          } else {
            record[lower] = String(v);
          }
        }
      }
    }

    if (defaultContentType !== undefined && record['content-type'] === undefined) {
      record['content-type'] = defaultContentType;
    }
    if (this._requestId !== undefined && record[this._cfg.requestIdHeader] === undefined) {
      record[this._cfg.requestIdHeader] = this._requestId;
    }

    return { record, setCookies };
  }

  private buildHeaders(initHeaders?: HeadersInit, defaultContentType?: string): Headers {
    const { record, setCookies } = this.buildHeaderRecord(initHeaders, defaultContentType);
    const headers = new Headers(record);
    if (setCookies !== null) {
      for (let i = 0; i < setCookies.length; i += 1) {
        const sc = setCookies[i];
        if (sc !== undefined) {
          headers.append('set-cookie', sc);
        }
      }
    }
    return headers;
  }

  private applyOpsToHeaders(target: Headers, fromIndex: number): void {
    const ops = this._cold?.headerOps;
    if (!ops) return;
    for (let i = fromIndex; i < ops.length; i += 1) {
      const op = ops[i];
      if (!op) continue;
      if (op.kind === 'set') {
        target.set(op.name, op.value);
      } else if (op.kind === 'append') {
        target.append(op.name, op.value);
      } else {
        target.delete(op.name);
      }
    }
  }

  public applyPendingHeaders(response: Response): Response {
    const cold = this._cold;
    if (cold === null || cold.headerOps === null || cold.appliedHeaderOpCount >= cold.headerOps.length) {
      return response;
    }

    if (response instanceof FastResponse) {
      this.applyOpsToHeaders(response.headers, cold.appliedHeaderOpCount);
      cold.appliedHeaderOpCount = cold.headerOps.length;
      return response;
    }

    const headers = new Headers(response.headers);
    this.applyOpsToHeaders(headers, cold.appliedHeaderOpCount);
    cold.appliedHeaderOpCount = cold.headerOps.length;

    const updated = new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
    return copyFastBody(response, updated);
  }

  public getStagedStatus(): number {
    return this.stagedStatus;
  }

  public markCommitted(): void {
    this._committed = true;
  }

  public json(data: unknown, init?: ResponseHelperInit): Response {
    const serialized = JSON.stringify(data);
    if (init === undefined && (this._cold === null || this._cold.headerOps === null) && this._requestId === undefined) {
      return createFastStaticResponse(serialized, this.stagedStatus, 'application/json; charset=utf-8');
    }
    const status = init?.status ?? this.stagedStatus;
    if (init?.headers === undefined && (this._cold === null || this._cold.headerOps === null) && this._requestId === undefined) {
      return createFastStaticResponse(serialized, status, 'application/json; charset=utf-8');
    }
    const { record, setCookies } = this.buildHeaderRecord(
      init?.headers,
      'application/json; charset=utf-8',
    );
    return createFastResponse(serialized, status, record, setCookies);
  }

  public text(body: string, init?: ResponseHelperInit): Response {
    if (init === undefined && (this._cold === null || this._cold.headerOps === null) && this._requestId === undefined) {
      return createFastStaticResponse(body, this.stagedStatus, 'text/plain; charset=utf-8');
    }
    const status = init?.status ?? this.stagedStatus;
    if (init?.headers === undefined && (this._cold === null || this._cold.headerOps === null) && this._requestId === undefined) {
      return createFastStaticResponse(body, status, 'text/plain; charset=utf-8');
    }
    const { record, setCookies } = this.buildHeaderRecord(
      init?.headers,
      'text/plain; charset=utf-8',
    );
    return createFastResponse(body, status, record, setCookies);
  }

  public html(body: string, init?: ResponseHelperInit): Response {
    if (init === undefined && (this._cold === null || this._cold.headerOps === null) && this._requestId === undefined) {
      return createFastStaticResponse(body, this.stagedStatus, 'text/html; charset=utf-8');
    }
    const status = init?.status ?? this.stagedStatus;
    if (init?.headers === undefined && (this._cold === null || this._cold.headerOps === null) && this._requestId === undefined) {
      return createFastStaticResponse(body, status, 'text/html; charset=utf-8');
    }
    const { record, setCookies } = this.buildHeaderRecord(
      init?.headers,
      'text/html; charset=utf-8',
    );
    return createFastResponse(body, status, record, setCookies);
  }

  public bytes(
    body: Uint8Array,
    contentType = 'application/octet-stream',
    init?: ResponseHelperInit,
  ): Response {
    const status = init?.status ?? this.stagedStatus;
    const { record, setCookies } = this.buildHeaderRecord(init?.headers, contentType);
    const copy = new Uint8Array(body.byteLength);
    copy.set(body);
    return createFastResponse(copy, status, record, setCookies);
  }

  public empty(statusCode = 204): Response {
    const { record, setCookies } = this.buildHeaderRecord();
    return createFastResponse(null, statusCode, record, setCookies);
  }

  public redirect(location: string, statusCode: RedirectStatusCode = 302): Response {
    if (!VALID_REDIRECT_STATUSES.has(statusCode)) {
      throw new BadRequestError(`Invalid redirect status code: ${statusCode}`);
    }
    if (INVALID_HEADER_VALUE.test(location) || location.trim().length === 0) {
      throw new BadRequestError('Invalid redirect location');
    }
    const { record, setCookies } = this.buildHeaderRecord({ location });
    return createFastResponse(null, statusCode, record, setCookies);
  }

  public stream(
    body: ReadableStream<Uint8Array>,
    contentType = 'application/octet-stream',
    init?: ResponseHelperInit,
  ): Response {
    const status = init?.status ?? this.stagedStatus;
    const headers = this.buildHeaders(init?.headers, contentType);
    return new Response(body, { status, headers });
  }

  public sse(producer: SseProducer, init?: Omit<ResponseHelperInit, 'status'>): Response {
    const headers = this.buildHeaders(init?.headers);
    return createSseResponse(producer, { headers, signal: this.signal });
  }

  public dispose(): Promise<void> | void {
    const cold = this._cold;
    if (cold !== null && cold.requestScope !== null) {
      const scope = cold.requestScope;
      cold.requestScope = null;
      return scope.dispose();
    }
  }
}
