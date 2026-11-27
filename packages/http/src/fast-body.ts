const GlobalResponse = globalThis.Response;
const GlobalHeaders = globalThis.Headers;
const IS_BUN = 'Bun' in globalThis;

const FAST_BODY_MAP = new WeakMap<Response, Uint8Array | string>();

export class FastHeaders {
  public readonly _map: Record<string, string>;
  public _setCookies: string[] | null = null;

  public constructor(initial?: Record<string, string>) {
    this._map = initial ?? (Object.create(null) as Record<string, string>);
  }

  public get(name: string): string | null {
    const k = name.toLowerCase();
    if (k === 'set-cookie') {
      return this._setCookies !== null && this._setCookies.length > 0
        ? this._setCookies.join(', ')
        : null;
    }
    return this._map[k] ?? null;
  }

  public has(name: string): boolean {
    const k = name.toLowerCase();
    if (k === 'set-cookie') {
      return this._setCookies !== null && this._setCookies.length > 0;
    }
    return this._map[k] !== undefined;
  }

  public set(name: string, value: string): void {
    const strVal = String(value);
    if (
      strVal.indexOf('\r') !== -1 ||
      strVal.indexOf('\n') !== -1 ||
      strVal.indexOf('\0') !== -1
    ) {
      throw new TypeError(`Invalid HTTP header value for "${name}"`);
    }
    const k = name.toLowerCase();
    if (k === 'set-cookie') {
      this._setCookies = [strVal];
      return;
    }
    this._map[k] = strVal;
  }

  public append(name: string, value: string): void {
    const strVal = String(value);
    if (
      strVal.indexOf('\r') !== -1 ||
      strVal.indexOf('\n') !== -1 ||
      strVal.indexOf('\0') !== -1
    ) {
      throw new TypeError(`Invalid HTTP header value for "${name}"`);
    }
    const k = name.toLowerCase();
    if (k === 'set-cookie') {
      if (this._setCookies === null) {
        this._setCookies = [];
      }
      this._setCookies.push(strVal);
      return;
    }
    const existing = this._map[k];
    this._map[k] = existing !== undefined ? `${existing}, ${strVal}` : strVal;
  }

  public delete(name: string): void {
    const k = name.toLowerCase();
    if (k === 'set-cookie') {
      this._setCookies = null;
      return;
    }
    delete this._map[k];
  }

  public getSetCookie(): string[] {
    return this._setCookies !== null ? [...this._setCookies] : [];
  }

  public *entries(): HeadersIterator<[string, string]> {
    for (const k in this._map) {
      const val = this._map[k];
      if (val !== undefined) {
        yield [k, val];
      }
    }
    if (this._setCookies !== null) {
      for (let i = 0; i < this._setCookies.length; i += 1) {
        const sc = this._setCookies[i];
        if (sc !== undefined) {
          yield ['set-cookie', sc];
        }
      }
    }
  }

  public *keys(): HeadersIterator<string> {
    for (const [k] of this.entries()) {
      yield k;
    }
  }

  public *values(): HeadersIterator<string> {
    for (const [, v] of this.entries()) {
      yield v;
    }
  }

  public [Symbol.iterator](): HeadersIterator<[string, string]> {
    return this.entries();
  }

  public forEach(
    callbackfn: (value: string, key: string, parent: Headers) => void,
    thisArg?: unknown,
  ): void {
    for (const [k, v] of this.entries()) {
      callbackfn.call(thisArg, v, k, this as unknown as Headers);
    }
  }
}
Object.setPrototypeOf(FastHeaders.prototype, GlobalHeaders.prototype);

export class FastResponse {
  public readonly _rawBody: Uint8Array | string | null;
  public readonly _status: number;
  public _contentType: string | null;
  public _fastHeaders: FastHeaders | null;
  private _native: Response | null = null;

  public constructor(
    body: Uint8Array | string | null,
    status: number,
    headers: FastHeaders | null,
    contentType: string | null = null,
  ) {
    this._rawBody = body;
    this._status = status;
    this._fastHeaders = headers;
    this._contentType = contentType;
  }

  public ensureFastHeaders(): FastHeaders {
    if (this._fastHeaders === null) {
      const map = Object.create(null) as Record<string, string>;
      if (this._contentType !== null) {
        map['content-type'] = this._contentType;
      }
      this._fastHeaders = new FastHeaders(map);
    }
    return this._fastHeaders;
  }

  private ensureNative(): Response {
    if (this._native === null) {
      const h = new GlobalHeaders();
      for (const [k, v] of this.ensureFastHeaders().entries()) {
        h.append(k, v);
      }
      this._native = new GlobalResponse(this._rawBody as BodyInit | null, {
        status: this._status,
        headers: h,
      });
    }
    return this._native;
  }

  public get status(): number {
    return this._status;
  }

  public get statusText(): string {
    return '';
  }

  public get ok(): boolean {
    return this._status >= 200 && this._status < 300;
  }

  public get redirected(): boolean {
    return false;
  }

  public get type(): ResponseType {
    return 'default';
  }

  public get url(): string {
    return '';
  }

  public get headers(): Headers {
    return this.ensureFastHeaders() as unknown as Headers;
  }

  public get body(): ReadableStream<Uint8Array> | null {
    if (this._rawBody === null) {
      return null;
    }
    return this.ensureNative().body;
  }

  public get bodyUsed(): boolean {
    return this._native !== null ? this._native.bodyUsed : false;
  }

  public async text(): Promise<string> {
    if (typeof this._rawBody === 'string') {
      return this._rawBody;
    }
    if (this._rawBody === null) {
      return '';
    }
    return new TextDecoder().decode(this._rawBody);
  }

  public async json(): Promise<unknown> {
    if (typeof this._rawBody === 'string') {
      return JSON.parse(this._rawBody);
    }
    const txt = await this.text();
    return JSON.parse(txt);
  }

  public async arrayBuffer(): Promise<ArrayBuffer> {
    if (this._rawBody === null) {
      return new ArrayBuffer(0);
    }
    if (typeof this._rawBody === 'string') {
      const u8 = new TextEncoder().encode(this._rawBody);
      const copy = new Uint8Array(u8.byteLength);
      copy.set(u8);
      return copy.buffer;
    }
    const copy = new Uint8Array(this._rawBody.byteLength);
    copy.set(this._rawBody);
    return copy.buffer;
  }

  public async bytes(): Promise<Uint8Array> {
    if (this._rawBody === null) {
      return new Uint8Array(0);
    }
    if (typeof this._rawBody === 'string') {
      return new TextEncoder().encode(this._rawBody);
    }
    return new Uint8Array(this._rawBody);
  }

  public async blob(): Promise<Blob> {
    return this.ensureNative().blob();
  }

  public async formData(): Promise<FormData> {
    return this.ensureNative().formData();
  }

  public clone(): Response {
    if (this._fastHeaders === null) {
      return new FastResponse(this._rawBody, this._status, null, this._contentType) as unknown as Response;
    }
    const clonedMap = Object.assign(Object.create(null), this._fastHeaders._map) as Record<
      string,
      string
    >;
    const clonedHeaders = new FastHeaders(clonedMap);
    if (this._fastHeaders._setCookies !== null) {
      clonedHeaders._setCookies = [...this._fastHeaders._setCookies];
    }
    return new FastResponse(this._rawBody, this._status, clonedHeaders, this._contentType) as unknown as Response;
  }
}
Object.setPrototypeOf(FastResponse.prototype, GlobalResponse.prototype);

const BUN_JSON_200_INIT: ResponseInit | null = IS_BUN
  ? { headers: new GlobalHeaders({ 'content-type': 'application/json; charset=utf-8' }) }
  : null;

const BUN_TEXT_200_INIT: ResponseInit | null = IS_BUN
  ? { headers: new GlobalHeaders({ 'content-type': 'text/plain; charset=utf-8' }) }
  : null;

const BUN_HTML_200_INIT: ResponseInit | null = IS_BUN
  ? { headers: new GlobalHeaders({ 'content-type': 'text/html; charset=utf-8' }) }
  : null;

export function createFastStaticResponse(
  body: string,
  status: number,
  contentType: string,
): Response {
  if (!IS_BUN) {
    return new FastResponse(body, status, null, contentType) as unknown as Response;
  }

  if (status === 200) {
    if (contentType === 'application/json; charset=utf-8') {
      return new GlobalResponse(body, BUN_JSON_200_INIT!);
    }
    if (contentType === 'text/plain; charset=utf-8') {
      return new GlobalResponse(body, BUN_TEXT_200_INIT!);
    }
    if (contentType === 'text/html; charset=utf-8') {
      return new GlobalResponse(body, BUN_HTML_200_INIT!);
    }
  }

  return new GlobalResponse(body, {
    status,
    headers: { 'content-type': contentType },
  });
}

export function createFastResponse(
  body: Uint8Array | string | null,
  status: number,
  headersRecord: Record<string, string>,
  setCookies: string[] | null = null,
): Response {
  if (!IS_BUN) {
    const fh = new FastHeaders(headersRecord);
    fh._setCookies = setCookies;
    return new FastResponse(body, status, fh) as unknown as Response;
  }

  if (setCookies === null || setCookies.length === 0) {
    return new GlobalResponse(body as BodyInit | null, {
      status,
      headers: headersRecord,
    });
  }

  const h = new GlobalHeaders(headersRecord);
  for (let i = 0; i < setCookies.length; i += 1) {
    const sc = setCookies[i];
    if (sc !== undefined) {
      h.append('set-cookie', sc);
    }
  }
  return new GlobalResponse(body as BodyInit | null, { status, headers: h });
}

export function attachFastBody(response: Response, body: Uint8Array | string): Response {
  if (response instanceof FastResponse) {
    return response;
  }
  FAST_BODY_MAP.set(response, body);
  return response;
}

export function getFastBody(response: Response): Uint8Array | string | undefined {
  if (response instanceof FastResponse) {
    if (response.bodyUsed) {
      return undefined;
    }
    return response._rawBody ?? undefined;
  }
  if (response.bodyUsed) {
    return undefined;
  }
  return FAST_BODY_MAP.get(response);
}

export function copyFastBody(from: Response, to: Response): Response {
  const body = getFastBody(from);
  if (body !== undefined) {
    if (!(to instanceof FastResponse)) {
      FAST_BODY_MAP.set(to, body);
    }
  }
  return to;
}
