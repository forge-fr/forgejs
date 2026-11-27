export const HTTP_METHODS = [
  'GET',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'OPTIONS',
  'HEAD',
] as const;

export type HttpMethod = (typeof HTTP_METHODS)[number];

export type RouterErrorCode =
  | 'INVALID_ROUTE'
  | 'INVALID_PARAM_NAME'
  | 'DUPLICATE_ROUTE'
  | 'INVALID_CONSTRAINT';

export class RouterError extends Error {
  public readonly code: RouterErrorCode;

  public constructor(code: RouterErrorCode, message: string) {
    super(message);
    this.name = 'RouterError';
    this.code = code;
    if (typeof Object.setPrototypeOf === 'function') {
      Object.setPrototypeOf(this, new.target.prototype);
    }
  }
}

export type ParamConstraint = RegExp | ((value: string) => boolean);

export interface RouteOptions<TMiddleware = unknown> {
  readonly name?: string;
  readonly middleware?: readonly TMiddleware[];
  readonly meta?: Readonly<Record<string, unknown>>;
  readonly constraints?: Readonly<Record<string, ParamConstraint>>;
}

export interface GroupOptions<TMiddleware = unknown> {
  readonly middleware?: readonly TMiddleware[];
  readonly meta?: Readonly<Record<string, unknown>>;
}

export interface RegisteredRoute<THandler = unknown, TMiddleware = unknown> {
  readonly method: HttpMethod;
  readonly path: string;
  readonly handler: THandler;
  readonly name?: string;
  readonly middleware: readonly TMiddleware[];
  readonly meta: Readonly<Record<string, unknown>>;
}

export type RouteMatchResult<THandler = unknown, TMiddleware = unknown> =
  | {
      readonly kind: 'found';
      readonly route: RegisteredRoute<THandler, TMiddleware>;
      readonly params: Readonly<Record<string, string>>;
      readonly matchedMethod: HttpMethod;
    }
  | {
      readonly kind: 'method_not_allowed';
      readonly allowedMethods: readonly HttpMethod[];
      readonly allowHeader: string;
    }
  | {
      readonly kind: 'not_found';
    };

export interface RouterOptions {
  readonly ignoreTrailingSlash?: boolean;
  readonly autoHead?: boolean;
}

export interface RouteBuilder<THandler = unknown, TMiddleware = unknown> {
  add(
    method: HttpMethod,
    path: string,
    handler: THandler,
    options?: RouteOptions<TMiddleware>,
  ): this;
  get(path: string, handler: THandler, options?: RouteOptions<TMiddleware>): this;
  post(path: string, handler: THandler, options?: RouteOptions<TMiddleware>): this;
  put(path: string, handler: THandler, options?: RouteOptions<TMiddleware>): this;
  patch(path: string, handler: THandler, options?: RouteOptions<TMiddleware>): this;
  delete(path: string, handler: THandler, options?: RouteOptions<TMiddleware>): this;
  options(path: string, handler: THandler, options?: RouteOptions<TMiddleware>): this;
  head(path: string, handler: THandler, options?: RouteOptions<TMiddleware>): this;
  all(path: string, handler: THandler, options?: RouteOptions<TMiddleware>): this;
  group(
    prefix: string,
    configure: (group: RouteBuilder<THandler, TMiddleware>) => void,
    options?: GroupOptions<TMiddleware>,
  ): this;
}

export interface Router<THandler = unknown, TMiddleware = unknown>
  extends RouteBuilder<THandler, TMiddleware> {
  match(method: string, rawPath: string): RouteMatchResult<THandler, TMiddleware>;
  routes(): readonly RegisteredRoute<THandler, TMiddleware>[];
}
