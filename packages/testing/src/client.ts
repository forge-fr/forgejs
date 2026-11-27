import type { ForgeHttpApp } from '@forge-fr/http';

export interface TestRequestOptions {
  readonly headers?: HeadersInit;
  readonly query?: Readonly<Record<string, string | readonly string[]>>;
  readonly json?: unknown;
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

export interface TestClientOptions {
  readonly baseUrl?: string;
  readonly autoStart?: boolean;
  readonly defaultHeaders?: HeadersInit;
}

export interface TestClient {
  request(method: string, path: string, options?: TestRequestOptions): Promise<TestResponse>;
  get(path: string, options?: Omit<TestRequestOptions, 'body' | 'json'>): Promise<TestResponse>;
  post(path: string, options?: TestRequestOptions): Promise<TestResponse>;
  put(path: string, options?: TestRequestOptions): Promise<TestResponse>;
  patch(path: string, options?: TestRequestOptions): Promise<TestResponse>;
  delete(path: string, options?: TestRequestOptions): Promise<TestResponse>;
  options(path: string, options?: Omit<TestRequestOptions, 'body' | 'json'>): Promise<TestResponse>;
  head(path: string, options?: Omit<TestRequestOptions, 'body' | 'json'>): Promise<TestResponse>;
  close(): Promise<void>;
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
    if (reqOptions.headers) {
      const extra = new Headers(reqOptions.headers);
      for (const [k, v] of extra.entries()) {
        headers.set(k, v);
      }
    }

    let body: BodyInit | null | undefined = reqOptions.body;
    if (reqOptions.json !== undefined) {
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

    return wrapResponse(raw);
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
    async close(): Promise<void> {
      await app.dispose();
    },
  };
}
