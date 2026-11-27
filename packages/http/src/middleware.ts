import { ForgeMiddlewareError } from './errors.js';
import type {
  ForgeContext,
  ForgeMiddleware,
  MiddlewareTier,
  RegisteredMiddleware,
} from './types.js';

const TIER_RANK: Readonly<Record<MiddlewareTier, number>> = {
  global: 0,
  module: 1,
  group: 2,
  route: 3,
};

export function sortMiddleware(
  entries: readonly RegisteredMiddleware[],
): readonly RegisteredMiddleware[] {
  return [...entries].sort((a, b) => {
    const tierDiff = TIER_RANK[a.tier] - TIER_RANK[b.tier];
    if (tierDiff !== 0) return tierDiff;
    if (a.priority !== b.priority) return a.priority - b.priority;
    return a.sequence - b.sequence;
  });
}

export function composeMiddleware(
  middlewares: readonly ForgeMiddleware[],
  terminal: (ctx: ForgeContext) => Promise<Response> | Response,
): (ctx: ForgeContext) => Promise<Response> | Response {
  const len = middlewares.length;

  return function runPipeline(ctx: ForgeContext): Promise<Response> | Response {
    let lastIndex = -1;
    let lastResponse: Response | undefined;

    function dispatch(index: number): Promise<Response> | Response {
      if (index <= lastIndex) {
        return Promise.reject(
          new ForgeMiddlewareError(
            'NEXT_ALREADY_CALLED',
            `Middleware at index ${index - 1} invoked next() multiple times`,
          ),
        );
      }
      lastIndex = index;

      if (index === len) {
        try {
          const termRes = terminal(ctx);
          if (termRes instanceof Promise) {
            return termRes.then((r) => {
              lastResponse = r;
              return r;
            });
          }
          lastResponse = termRes;
          return termRes;
        } catch (err: unknown) {
          return Promise.reject(err);
        }
      }

      const fn = middlewares[index]!;
      let nextCalled = false;
      let downstreamResult: Promise<Response> | Response | undefined;

      const next = (): Promise<Response> => {
        if (nextCalled) {
          return Promise.reject(
            new ForgeMiddlewareError(
              'NEXT_ALREADY_CALLED',
              `Middleware "${fn.name || `#${index}`}" invoked next() multiple times`,
            ),
          );
        }
        nextCalled = true;
        const res = dispatch(index + 1);
        downstreamResult = res;
        return res as unknown as Promise<Response>;
      };

      let returned: Promise<Response | void> | Response | void;
      try {
        returned = fn(ctx, next);
      } catch (err: unknown) {
        return Promise.reject(err);
      }

      if (returned instanceof Response) {
        lastResponse = returned;
        return returned;
      }

      if (returned instanceof Promise) {
        if (index > 0 && nextCalled && !(downstreamResult instanceof Promise)) {
          return returned as Promise<Response>;
        }
        return returned.then((resolved) => {
          if (resolved instanceof Response) {
            lastResponse = resolved;
            return resolved;
          }
          if (lastResponse !== undefined) {
            return lastResponse;
          }
          if (downstreamResult !== undefined) {
            return downstreamResult;
          }
          throw new ForgeMiddlewareError(
            'MIDDLEWARE_ERROR',
            `Middleware "${fn.name || `#${index}`}" completed without calling next() or returning a Response`,
          );
        });
      }

      if (downstreamResult !== undefined) {
        return downstreamResult;
      }

      return Promise.reject(
        new ForgeMiddlewareError(
          'MIDDLEWARE_ERROR',
          `Middleware "${fn.name || `#${index}`}" completed without calling next() or returning a Response`,
        ),
      );
    }

    return dispatch(0);
  };
}
