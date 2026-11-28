import {
  createKernel,
  createNoopLogger,
  type ApplicationKernel,
  type HealthReport,
  type InjectionToken,
  type KernelOptions,
} from '@forge-fr/core';
import {
  createHttpApp,
  type ForgeHttpApp,
  type HttpAppOptions,
} from '@forge-fr/http';
import {
  createTestClient,
  type TestClient,
  type TestClientOptions,
  type TestRequestOptions,
  type TestResponse,
  type TestSseResponse,
} from './client.js';
import { applyOverrides, overrideProvider, overrideValue, type TestOverride } from './di.js';

export interface TestKernelOptions extends KernelOptions {
  /** Strongly typed DI overrides applied after module & plugin registration and before initialization. */
  readonly overrides?: readonly TestOverride[];
  /** Automatically configure, register, apply overrides, and initialize the kernel. Default: `true`. */
  readonly autoStart?: boolean;
}

export interface TestKernel {
  readonly kernel: ApplicationKernel;
  resolve<T>(token: InjectionToken<T>): T;
  resolveOptional<T>(token: InjectionToken<T>): T | undefined;
  override<T>(token: InjectionToken<T>, value: T): this;
  overrideProvider(provider: TestOverride): this;
  health(): Promise<HealthReport>;
  start(): Promise<void>;
  dispose(): Promise<void>;
  [Symbol.asyncDispose](): Promise<void>;
}

/**
 * Boots an isolated `ApplicationKernel` for testing with silent logging by default,
 * deterministic DI overrides (including over plugin-registered providers), and
 * `await using` (`Symbol.asyncDispose`) cleanup support.
 */
export async function createTestKernel(
  options: TestKernelOptions = {},
): Promise<TestKernel> {
  const { overrides, autoStart = true, logger, ...kernelOpts } = options;
  const kernel = createKernel({
    ...kernelOpts,
    logger: logger ?? createNoopLogger(),
  });

  if (autoStart) {
    await kernel.configure();
    await kernel.register();
    applyOverrides(kernel, overrides);
    await kernel.initialize();
  } else {
    applyOverrides(kernel, overrides);
  }

  let disposed = false;
  async function dispose(): Promise<void> {
    if (disposed) {
      return;
    }
    disposed = true;
    await kernel.dispose();
  }

  const handle: TestKernel = {
    kernel,
    resolve: <T>(token: InjectionToken<T>): T => kernel.container.resolve(token),
    resolveOptional: <T>(token: InjectionToken<T>): T | undefined =>
      kernel.container.resolveOptional(token),
    override<T>(token: InjectionToken<T>, value: T): TestKernel {
      overrideProvider(kernel, overrideValue(token, value));
      return handle;
    },
    overrideProvider(provider: TestOverride): TestKernel {
      overrideProvider(kernel, provider);
      return handle;
    },
    health: () => kernel.health.runAll(),
    start: () => kernel.start(),
    dispose,
    [Symbol.asyncDispose]: dispose,
  };

  return handle;
}

export interface TestAppOptions extends HttpAppOptions {
  /** Optional callback to register routes, middleware, or hooks before the app starts. */
  readonly setup?: (app: ForgeHttpApp) => Promise<void> | void;
  /** Strongly typed DI overrides applied after module & plugin registration and before initialization. */
  readonly overrides?: readonly TestOverride[];
  /** Options forwarded to the attached `TestClient` (e.g. `cookieJar: true`, `defaultHeaders`). */
  readonly client?: Omit<TestClientOptions, 'autoStart'>;
  /** Automatically configure, register, apply overrides, and initialize the app. Default: `true`. */
  readonly autoStart?: boolean;
}

export interface TestApp {
  readonly app: ForgeHttpApp;
  readonly kernel: ApplicationKernel;
  readonly client: TestClient;
  resolve<T>(token: InjectionToken<T>): T;
  resolveOptional<T>(token: InjectionToken<T>): T | undefined;
  override<T>(token: InjectionToken<T>, value: T): this;
  overrideProvider(provider: TestOverride): this;
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
  dispose(): Promise<void>;
  [Symbol.asyncDispose](): Promise<void>;
}

/**
 * Boots an isolated `ForgeHttpApp` paired with an in-memory `TestClient`,
 * typed DI overrides, optional cookie jar/SSE/multipart helpers, and `await using` cleanup.
 */
export async function createTestApp(options: TestAppOptions = {}): Promise<TestApp> {
  const { setup, overrides, client: clientOpts, autoStart = true, logger, ...appOpts } = options;

  const app = createHttpApp({
    ...appOpts,
    logger: logger ?? createNoopLogger(),
  });

  if (setup !== undefined) {
    await setup(app);
  }

  if (autoStart) {
    await app.kernel.configure();
    await app.kernel.register();
    applyOverrides(app.kernel, overrides);
    await app.kernel.initialize();
  } else {
    applyOverrides(app.kernel, overrides);
  }

  const client = createTestClient(app, {
    ...(clientOpts ?? {}),
    autoStart: !autoStart,
  });

  let closed = false;
  async function close(): Promise<void> {
    if (closed) {
      return;
    }
    closed = true;
    await app.dispose();
  }

  const handle: TestApp = {
    app,
    kernel: app.kernel,
    client,
    resolve: <T>(token: InjectionToken<T>): T => app.kernel.container.resolve(token),
    resolveOptional: <T>(token: InjectionToken<T>): T | undefined =>
      app.kernel.container.resolveOptional(token),
    override<T>(token: InjectionToken<T>, value: T): TestApp {
      overrideProvider(app.kernel, overrideValue(token, value));
      return handle;
    },
    overrideProvider(provider: TestOverride): TestApp {
      overrideProvider(app.kernel, provider);
      return handle;
    },
    request: (method, path, opts) => client.request(method, path, opts),
    get: (path, opts) => client.get(path, opts),
    post: (path, opts) => client.post(path, opts),
    put: (path, opts) => client.put(path, opts),
    patch: (path, opts) => client.patch(path, opts),
    delete: (path, opts) => client.delete(path, opts),
    options: (path, opts) => client.options(path, opts),
    head: (path, opts) => client.head(path, opts),
    sse: (path, opts) => client.sse(path, opts),
    cookies: () => client.cookies(),
    clearCookies: () => client.clearCookies(),
    close,
    dispose: close,
    [Symbol.asyncDispose]: close,
  };

  return handle;
}
