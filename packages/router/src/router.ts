import {
  joinRoutePaths,
  normalizePathname,
  parseRoutePath,
  splitNormalizedPath,
} from './path.js';
import { RadixTree } from './radix.js';
import {
  HTTP_METHODS,
  type GroupOptions,
  type HttpMethod,
  type RegisteredRoute,
  type RouteBuilder,
  type RouteMatchResult,
  type RouteOptions,
  type Router,
  type RouterOptions,
} from './types.js';

const METHOD_SET: ReadonlySet<string> = new Set(HTTP_METHODS);

interface GroupContext<TMiddleware> {
  readonly prefix: string;
  readonly middleware: readonly TMiddleware[];
  readonly meta: Readonly<Record<string, unknown>>;
}

function createBuilder<THandler, TMiddleware>(
  registerRoute: (
    method: HttpMethod,
    path: string,
    handler: THandler,
    options: RouteOptions<TMiddleware> | undefined,
    groupCtx: GroupContext<TMiddleware>,
  ) => void,
  groupCtx: GroupContext<TMiddleware>,
): RouteBuilder<THandler, TMiddleware> {
  const builder: RouteBuilder<THandler, TMiddleware> = {
    add(method, path, handler, options) {
      registerRoute(method, path, handler, options, groupCtx);
      return builder;
    },
    get(path, handler, options) {
      return builder.add('GET', path, handler, options);
    },
    post(path, handler, options) {
      return builder.add('POST', path, handler, options);
    },
    put(path, handler, options) {
      return builder.add('PUT', path, handler, options);
    },
    patch(path, handler, options) {
      return builder.add('PATCH', path, handler, options);
    },
    delete(path, handler, options) {
      return builder.add('DELETE', path, handler, options);
    },
    options(path, handler, options) {
      return builder.add('OPTIONS', path, handler, options);
    },
    head(path, handler, options) {
      return builder.add('HEAD', path, handler, options);
    },
    all(path, handler, options) {
      for (const method of HTTP_METHODS) {
        registerRoute(method, path, handler, options, groupCtx);
      }
      return builder;
    },
    group(prefix, configure, options) {
      const nextContext: GroupContext<TMiddleware> = {
        prefix: joinRoutePaths(groupCtx.prefix, prefix),
        middleware: [...groupCtx.middleware, ...(options?.middleware ?? [])],
        meta: { ...groupCtx.meta, ...(options?.meta ?? {}) },
      };
      const childBuilder = createBuilder(registerRoute, nextContext);
      configure(childBuilder);
      return builder;
    },
  };

  return builder;
}

export function createRouter<THandler = unknown, TMiddleware = unknown>(
  options: RouterOptions = {},
): Router<THandler, TMiddleware> {
  const ignoreTrailingSlash = options.ignoreTrailingSlash ?? true;
  const autoHead = options.autoHead ?? true;
  const tree = new RadixTree<THandler, TMiddleware>();
  const registeredRoutes: RegisteredRoute<THandler, TMiddleware>[] = [];

  const EMPTY_PARAMS: Readonly<Record<string, string>> = Object.freeze(Object.create(null));
  const staticByMethod: Record<string, Map<string, RouteMatchResult<THandler, TMiddleware>>> = {
    GET: new Map(),
    POST: new Map(),
    PUT: new Map(),
    PATCH: new Map(),
    DELETE: new Map(),
    OPTIONS: new Map(),
    HEAD: new Map(),
  };
  const staticGetRoutes = new Map<string, RegisteredRoute<THandler, TMiddleware>>();

  function registerRoute(
    method: HttpMethod,
    path: string,
    handler: THandler,
    routeOptions: RouteOptions<TMiddleware> | undefined,
    groupCtx: GroupContext<TMiddleware>,
  ): void {
    const combinedPath = joinRoutePaths(groupCtx.prefix, path);
    const parsed = parseRoutePath(
      combinedPath,
      ignoreTrailingSlash,
      routeOptions?.constraints,
    );

    const route: RegisteredRoute<THandler, TMiddleware> = {
      method,
      path: parsed.normalizedPath,
      handler,
      ...(routeOptions?.name !== undefined ? { name: routeOptions.name } : {}),
      middleware: Object.freeze([
        ...groupCtx.middleware,
        ...(routeOptions?.middleware ?? []),
      ]),
      meta: Object.freeze({
        ...groupCtx.meta,
        ...(routeOptions?.meta ?? {}),
      }),
    };

    tree.insert(parsed, route);
    registeredRoutes.push(route);

    if (parsed.segments.every((s) => s.kind === 'static')) {
      const methodMap = staticByMethod[method];
      if (methodMap !== undefined) {
        methodMap.set(parsed.normalizedPath, {
          kind: 'found',
          route,
          params: EMPTY_PARAMS,
          matchedMethod: method,
        });
      }
      if (method === 'GET') {
        staticGetRoutes.set(parsed.normalizedPath, route);
      }
    }
  }

  const rootContext: GroupContext<TMiddleware> = {
    prefix: '',
    middleware: [],
    meta: {},
  };

  const baseBuilder = createBuilder(registerRoute, rootContext);

  const router: Router<THandler, TMiddleware> = {
    add(method, path, handler, routeOptions) {
      baseBuilder.add(method, path, handler, routeOptions);
      return router;
    },
    get(path, handler, routeOptions) {
      baseBuilder.get(path, handler, routeOptions);
      return router;
    },
    post(path, handler, routeOptions) {
      baseBuilder.post(path, handler, routeOptions);
      return router;
    },
    put(path, handler, routeOptions) {
      baseBuilder.put(path, handler, routeOptions);
      return router;
    },
    patch(path, handler, routeOptions) {
      baseBuilder.patch(path, handler, routeOptions);
      return router;
    },
    delete(path, handler, routeOptions) {
      baseBuilder.delete(path, handler, routeOptions);
      return router;
    },
    options(path, handler, routeOptions) {
      baseBuilder.options(path, handler, routeOptions);
      return router;
    },
    head(path, handler, routeOptions) {
      baseBuilder.head(path, handler, routeOptions);
      return router;
    },
    all(path, handler, routeOptions) {
      baseBuilder.all(path, handler, routeOptions);
      return router;
    },
    group(prefix, configure, groupOptions) {
      baseBuilder.group(prefix, configure, groupOptions);
      return router;
    },
    match(rawMethod: string, rawPath: string): RouteMatchResult<THandler, TMiddleware> {
      // Fast O(1) lookup for already-normalized static routes (e.g., 'GET', '/json')
      const fastMap = staticByMethod[rawMethod];
      if (fastMap !== undefined) {
        const fastHit = fastMap.get(rawPath);
        if (fastHit !== undefined) {
          return fastHit;
        }
      }

      const upperMethod =
        fastMap !== undefined
          ? rawMethod
          : rawMethod.toUpperCase();
      const pathname = normalizePathname(rawPath, ignoreTrailingSlash);

      const methodMap = fastMap ?? staticByMethod[upperMethod];
      if (methodMap !== undefined) {
        if (pathname !== rawPath) {
          const directHit = methodMap.get(pathname);
          if (directHit !== undefined) {
            return directHit;
          }
        }

        if (autoHead && upperMethod === 'HEAD') {
          const getHit = staticGetRoutes.get(pathname);
          if (getHit !== undefined) {
            return {
              kind: 'found',
              route: getHit,
              params: EMPTY_PARAMS,
              matchedMethod: 'GET',
            };
          }
        }

        const hit = tree.findMatchFromString(upperMethod as HttpMethod, pathname, autoHead);
        if (hit !== undefined) {
          return {
            kind: 'found',
            route: hit.stored.route,
            params: hit.params,
            matchedMethod: hit.matchedMethod,
          };
        }

        const allowedMethods = tree.collectAllowedMethodsFromString(pathname, autoHead);
        if (allowedMethods.length > 0) {
          return {
            kind: 'method_not_allowed',
            allowedMethods,
            allowHeader: allowedMethods.join(', '),
          };
        }
      } else if (METHOD_SET.has(upperMethod)) {
        const hit = tree.findMatchFromString(upperMethod as HttpMethod, pathname, autoHead);
        if (hit !== undefined) {
          return {
            kind: 'found',
            route: hit.stored.route,
            params: hit.params,
            matchedMethod: hit.matchedMethod,
          };
        }
        const allowedMethods = tree.collectAllowedMethodsFromString(pathname, autoHead);
        if (allowedMethods.length > 0) {
          return {
            kind: 'method_not_allowed',
            allowedMethods,
            allowHeader: allowedMethods.join(', '),
          };
        }
      } else {
        const allowedMethods = tree.collectAllowedMethodsFromString(pathname, autoHead);
        if (allowedMethods.length > 0) {
          return {
            kind: 'method_not_allowed',
            allowedMethods,
            allowHeader: allowedMethods.join(', '),
          };
        }
      }

      return { kind: 'not_found' };
    },
    routes() {
      return Object.freeze([...registeredRoutes]);
    },
  };

  return router;
}
