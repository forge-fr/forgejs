import type { ForgeHttpApp } from '@forge-fr/http';

export interface TestMultipartFile {
  readonly filename: string;
  readonly content: string | Uint8Array | ArrayBuffer;
  readonly contentType?: string;
}

export type TestMultipartFieldValue = string | Blob | TestMultipartFile;

export interface TestRequestOptions {
  readonly headers?: HeadersInit;
  readonly query?: Readonly<Record<string, string | readonly string[]>>;
  readonly json?: unknown;
  /** Sends an `application/x-www-form-urlencoded` body. */
  readonly form?: Readonly<Record<string, string | readonly string[]>>;
  /** Sends a `multipart/form-data` body with text fields and/or binary files. */
  readonly multipart?: Readonly<
    Record<string, TestMultipartFieldValue | readonly TestMultipartFieldValue[]>
  >;
  readonly body?: BodyInit | null;
  readonly remoteAddress?: string;
  readonly signal?: AbortSignal;
}

export interface TestResponse {
  readonly raw: Response;
  readonly status: number;
  readonly ok: boolean;
  readonly headers: Headers;
  header(name: string): string | null;
  setCookies(): string[];
  text(): Promise<string>;
  json<T = unknown>(): Promise<T>;
  bytes(): Promise<Uint8Array>;
}

export interface ParsedSseMessage {
  readonly id?: string;
  readonly event: string;
  readonly data: string;
  readonly retry?: number;
  json<T = unknown>(): T;
}

export interface TestSseResponse {
  readonly raw: Response;
  readonly status: number;
  readonly ok: boolean;
  readonly headers: Headers;
  readonly events: readonly ParsedSseMessage[];
  readonly comments: readonly string[];
}

export interface TestClientOptions {
  readonly baseUrl?: string;
  readonly autoStart?: boolean;
  readonly defaultHeaders?: HeadersInit;
  /** When `true`, automatically persists `Set-Cookie` headers and sends `Cookie` on subsequent requests. */
  readonly cookieJar?: boolean;
}

export interface TestClient {
  request(method: string, path: string, options?: TestRequestOptions): Promise<TestResponse>;
  get(path: string, options?: Omit<TestRequestOptions, 'body' | 'json' | 'form' | 'multipart'>): Promise<TestResponse>;
  post(path: string, options?: TestRequestOptions): Promise<TestResponse>;
  put(path: string, options?: TestRequestOptions): Promise<TestResponse>;
  patch(path: string, options?: TestRequestOptions): Promise<TestResponse>;
  delete(path: string, options?: TestRequestOptions): Promise<TestResponse>;
  options(path: string, options?: Omit<TestRequestOptions, 'body' | 'json' | 'form' | 'multipart'>): Promise<TestResponse>;
  head(path: string, options?: Omit<TestRequestOptions, 'body' | 'json' | 'form' | 'multipart'>): Promise<TestResponse>;
  sse(
    path: string,
    options?: Omit<TestRequestOptions, 'body' | 'json' | 'form' | 'multipart'>,
  ): Promise<TestSseResponse>;
  cookies(): Readonly<Record<string, string>>;
  clearCookies(): void;
  close(): Promise<void>;
  [Symbol.asyncDispose](): Promise<void>;
}

function isTestMultipartFile(value: unknown): value is TestMultipartFile {
  return (
    typeof value === 'object' &&
    value !== null &&
    'filename' in value &&
    'content' in value &&
    typeof (value as { filename?: unknown }).filename === 'string'
  );
}

function appendMultipartValue(formData: FormData, field: string, value: TestMultipartFieldValue): void {
  if (typeof value === 'string') {
    formData.append(field, value);
    return;
  }
  if (value instanceof Blob) {
    formData.append(field, value);
    return;
  }
  if (isTestMultipartFile(value)) {
    let blobPart: BlobPart;
    if (typeof value.content === 'string') {
      blobPart = value.content;
    } else if (value.content instanceof Uint8Array) {
      const copy = new Uint8Array(value.content.byteLength);
      copy.set(value.content);
      blobPart = copy.buffer;
    } else {
      blobPart = value.content;
    }
    const blob = new Blob([blobPart], {
      type: value.contentType ?? 'application/octet-stream',
    });
    formData.append(field, blob, value.filename);
  }
}

function buildMultipartFormData(
  fields: Readonly<Record<string, TestMultipartFieldValue | readonly TestMultipartFieldValue[]>>,
): FormData {
  const formData = new FormData();
  for (const [field, rawVal] of Object.entries(fields)) {
    if (Array.isArray(rawVal)) {
      for (const item of rawVal) {
        appendMultipartValue(formData, field, item);
      }
    } else {
      appendMultipartValue(formData, field, rawVal as TestMultipartFieldValue);
    }
  }
  return formData;
}

function parseSseStreamText(rawText: string): {
  events: ParsedSseMessage[];
  comments: string[];
} {
  const events: ParsedSseMessage[] = [];
  const comments: string[] = [];
  const normalized = rawText.replace(/\r\n?/g, '\n');
  const blocks = normalized.split('\n\n');

  for (const block of blocks) {
    if (block.length === 0) {
      continue;
    }
    let id: string | undefined;
    let eventName = 'message';
    let retry: number | undefined;
    const dataLines: string[] = [];

    for (const line of block.split('\n')) {
      if (line.length === 0) {
        continue;
      }
      if (line.startsWith(':')) {
        comments.push(line.slice(1).trimStart());
        continue;
      }
      const colonIdx = line.indexOf(':');
      const field = colonIdx === -1 ? line : line.slice(0, colonIdx);
      const rawVal = colonIdx === -1 ? '' : line.slice(colonIdx + 1);
      const value = rawVal.startsWith(' ') ? rawVal.slice(1) : rawVal;

      if (field === 'event') {
        eventName = value;
      } else if (field === 'data') {
        dataLines.push(value);
      } else if (field === 'id') {
        id = value;
      } else if (field === 'retry') {
        const parsedRetry = Number(value);
        if (Number.isInteger(parsedRetry) && parsedRetry >= 0) {
          retry = parsedRetry;
        }
      }
    }

    if (dataLines.length > 0 || id !== undefined || eventName !== 'message') {
      const data = dataLines.join('\n');
      events.push({
        ...(id !== undefined ? { id } : {}),
        event: eventName,
        data,
        ...(retry !== undefined ? { retry } : {}),
        json<T = unknown>(): T {
          return JSON.parse(data) as T;
        },
      });
    }
  }

  return { events, comments };
}

function updateCookieJar(jar: Map<string, string>, setCookieHeaders: readonly string[]): void {
  for (const header of setCookieHeaders) {
    const parts = header.split(';').map((p) => p.trim());
    const pair = parts[0];
    if (!pair) continue;
    const eqIdx = pair.indexOf('=');
    if (eqIdx <= 0) continue;
    const name = pair.slice(0, eqIdx).trim();
    const value = pair.slice(eqIdx + 1).trim();

    let expired = false;
    for (let i = 1; i < parts.length; i += 1) {
      const attr = parts[i]!.toLowerCase();
      if (attr === 'max-age=0' || attr.startsWith('max-age=-')) {
        expired = true;
      } else if (attr.startsWith('expires=')) {
        const expDate = Date.parse(parts[i]!.slice('expires='.length).trim());
        if (!Number.isNaN(expDate) && expDate <= Date.now()) {
          expired = true;
        }
      }
    }

    if (expired || value.length === 0) {
      jar.delete(name);
    } else {
      jar.set(name, value);
    }
  }
}

function serializeCookieJar(jar: ReadonlyMap<string, string>): string | undefined {
  if (jar.size === 0) {
    return undefined;
  }
  const pairs: string[] = [];
  for (const [k, v] of jar.entries()) {
    pairs.push(`${k}=${v}`);
  }
  return pairs.join('; ');
}

function wrapResponse(raw: Response): TestResponse {
  return {
    raw,
    status: raw.status,
    ok: raw.ok,
    headers: raw.headers,
    header(name: string): string | null {
      return raw.headers.get(name);
    },
    setCookies(): string[] {
      return typeof raw.headers.getSetCookie === 'function' ? raw.headers.getSetCookie() : [];
    },
    text(): Promise<string> {
      return raw.text();
    },
    json<T = unknown>(): Promise<T> {
      return raw.json() as Promise<T>;
    },
    async bytes(): Promise<Uint8Array> {
      const buf = await raw.arrayBuffer();
      return new Uint8Array(buf);
    },
  };
}

export function createTestClient(
  app: ForgeHttpApp,
  options: TestClientOptions = {},
): TestClient {
  const baseUrl = options.baseUrl ?? 'http://memory.forgejs.local';
  const autoStart = options.autoStart ?? true;
  const useCookieJar = options.cookieJar === true;
  const jar = new Map<string, string>();

  async function ensureStarted(): Promise<void> {
    if (autoStart && app.kernel.state === 'created') {
      await app.start();
    }
  }

  async function execute(
    method: string,
    path: string,
    reqOptions: TestRequestOptions = {},
  ): Promise<TestResponse> {
    await ensureStarted();

    const url = new URL(path, baseUrl);
    if (reqOptions.query) {
      for (const [key, val] of Object.entries(reqOptions.query)) {
        if (Array.isArray(val)) {
          for (const item of val) {
            url.searchParams.append(key, item);
          }
        } else {
          url.searchParams.set(key, val as string);
        }
      }
    }

    const headers = new Headers(options.defaultHeaders);
    if (useCookieJar) {
      const cookieHeader = serializeCookieJar(jar);
      if (cookieHeader !== undefined && !headers.has('cookie')) {
        headers.set('cookie', cookieHeader);
      }
    }
    if (reqOptions.headers) {
      const extra = new Headers(reqOptions.headers);
      for (const [k, v] of extra.entries()) {
        headers.set(k, v);
      }
    }

    let body: BodyInit | null | undefined = reqOptions.body;
    if (reqOptions.multipart !== undefined) {
      body = buildMultipartFormData(reqOptions.multipart);
      headers.delete('content-type');
    } else if (reqOptions.form !== undefined) {
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries(reqOptions.form)) {
        if (Array.isArray(v)) {
          for (const item of v) {
            params.append(k, item);
          }
        } else {
          params.set(k, v as string);
        }
      }
      body = params.toString();
      if (!headers.has('content-type')) {
        headers.set('content-type', 'application/x-www-form-urlencoded; charset=utf-8');
      }
    } else if (reqOptions.json !== undefined) {
      body = JSON.stringify(reqOptions.json);
      if (!headers.has('content-type')) {
        headers.set('content-type', 'application/json; charset=utf-8');
      }
    }

    const init: RequestInit = {
      method: method.toUpperCase(),
      headers,
    };
    if (body !== undefined && body !== null) {
      init.body = body;
    }
    if (reqOptions.signal !== undefined) {
      init.signal = reqOptions.signal;
    }

    const request = new Request(url, init);
    const raw = await app.fetch(request, {
      runtime: 'memory',
      ...(reqOptions.remoteAddress !== undefined ? { remoteAddress: reqOptions.remoteAddress } : {}),
      ...(reqOptions.signal !== undefined ? { signal: reqOptions.signal } : {}),
    });

    const wrapped = wrapResponse(raw);
    if (useCookieJar) {
      updateCookieJar(jar, wrapped.setCookies());
    }

    return wrapped;
  }

  async function sse(
    path: string,
    reqOptions: Omit<TestRequestOptions, 'body' | 'json' | 'form' | 'multipart'> = {},
  ): Promise<TestSseResponse> {
    const headers = new Headers(reqOptions.headers);
    if (!headers.has('accept')) {
      headers.set('accept', 'text/event-stream');
    }
    const res = await execute('GET', path, { ...reqOptions, headers });
    const text = await res.text();
    const { events, comments } = parseSseStreamText(text);
    return {
      raw: res.raw,
      status: res.status,
      ok: res.ok,
      headers: res.headers,
      events,
      comments,
    };
  }

  async function close(): Promise<void> {
    await app.dispose();
  }

  return {
    request: execute,
    get: (path, opts) => execute('GET', path, opts),
    post: (path, opts) => execute('POST', path, opts),
    put: (path, opts) => execute('PUT', path, opts),
    patch: (path, opts) => execute('PATCH', path, opts),
    delete: (path, opts) => execute('DELETE', path, opts),
    options: (path, opts) => execute('OPTIONS', path, opts),
    head: (path, opts) => execute('HEAD', path, opts),
    sse,
    cookies(): Readonly<Record<string, string>> {
      const snapshot: Record<string, string> = {};
      for (const [k, v] of jar.entries()) {
        snapshot[k] = v;
      }
      return Object.freeze(snapshot);
    },
    clearCookies(): void {
      jar.clear();
    },
    close,
    [Symbol.asyncDispose]: close,
  };
}
