import { isForgeError, normalizeError } from '@forge-fr/core';
import { createRouter, type Router } from '@forge-fr/router';
import type {
  RegisteredWebSocketRoute,
  RuntimeRequestMeta,
  WebSocketCloseInfo,
  WebSocketConnection,
  WebSocketHandlers,
  WebSocketMessageData,
  WebSocketRouteOptions,
  WebSocketUpgradeCheckResult,
  WebSocketUpgradeContext,
} from './types.js';

export type {
  RegisteredWebSocketRoute,
  WebSocketCloseInfo,
  WebSocketConnection,
  WebSocketHandlers,
  WebSocketMessageData,
  WebSocketRouteOptions,
  WebSocketUpgradeCheckResult,
  WebSocketUpgradeContext,
};

export const DEFAULT_WS_MAX_PAYLOAD_BYTES = 1_048_576;

function normalizeOrigin(rawOrigin: string): string | undefined {
  try {
    const parsed = new URL(rawOrigin);
    if (parsed.origin === 'null') {
      return undefined;
    }
    return parsed.origin.toLowerCase();
  } catch {
    return undefined;
  }
}

function selectSubprotocol(
  headerValue: string | null,
  supported: readonly string[] | undefined,
): string {
  if (!headerValue || !supported || supported.length === 0) {
    return '';
  }
  const offered = headerValue
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const allowed = new Set(supported);
  for (const candidate of offered) {
    if (allowed.has(candidate)) {
      return candidate;
    }
  }
  return '';
}

function parseQueryRecord(url: URL): Readonly<Record<string, string>> {
  const out: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [k, v] of url.searchParams.entries()) {
    if (k === '__proto__' || k === 'constructor' || k === 'prototype') {
      continue;
    }
    if (out[k] === undefined) {
      out[k] = v;
    }
  }
  return Object.freeze(out);
}

export class WebSocketRouteRegistry {
  private readonly router: Router<RegisteredWebSocketRoute, never> = createRouter();

  public register(
    path: string,
    handlers: WebSocketHandlers,
    options: WebSocketRouteOptions = {},
  ): RegisteredWebSocketRoute {
    const entry: RegisteredWebSocketRoute = {
      path,
      handlers,
      options,
      maxPayloadBytes: options.maxPayloadBytes ?? DEFAULT_WS_MAX_PAYLOAD_BYTES,
    };
    this.router.add('GET', path, entry, {
      ...(options.constraints !== undefined ? { constraints: options.constraints } : {}),
    });
    return entry;
  }

  public list(): readonly RegisteredWebSocketRoute[] {
    return this.router.routes().map((r) => r.handler);
  }

  public async authorizeUpgrade(
    request: Request,
    meta?: RuntimeRequestMeta,
  ): Promise<WebSocketUpgradeCheckResult> {
    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      url = new URL(request.url.startsWith('/') ? request.url : `/${request.url}`, 'http://localhost');
    }

    const match = this.router.match('GET', url.pathname);
    if (match.kind !== 'found') {
      return {
        accepted: false,
        response: new Response(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'WebSocket route not found' } }), {
          status: 404,
          headers: { 'content-type': 'application/json; charset=utf-8' },
        }),
      };
    }

    const route = match.route.handler;

    // 1. CSWSH Origin validation when allowlist is configured
    if (route.options.allowedOrigins && route.options.allowedOrigins.length > 0) {
      const originHeader = request.headers.get('origin');
      const normalizedOrigin = originHeader ? normalizeOrigin(originHeader) : undefined;
      const allowedSet = new Set(
        route.options.allowedOrigins
          .map((o) => normalizeOrigin(o))
          .filter((o): o is string => o !== undefined),
      );

      if (!normalizedOrigin || !allowedSet.has(normalizedOrigin)) {
        return {
          accepted: false,
          response: new Response(
            JSON.stringify({
              error: { code: 'FORBIDDEN', message: 'WebSocket Origin rejected' },
            }),
            {
              status: 403,
              headers: { 'content-type': 'application/json; charset=utf-8' },
            },
          ),
        };
      }
    }

    const upgradeContext: WebSocketUpgradeContext = {
      request,
      url,
      path: url.pathname,
      headers: request.headers,
      params: match.params,
      query: parseQueryRecord(url),
      ...(meta?.remoteAddress !== undefined ? { remoteAddress: meta.remoteAddress } : {}),
      runtime: meta?.runtime ?? 'fetch',
      protocol: selectSubprotocol(
        request.headers.get('sec-websocket-protocol'),
        route.options.protocols,
      ),
      state: new Map<string, unknown>(),
    };

    // 2. Pre-upgrade authentication hook BEFORE 101 Switching Protocols
    if (route.handlers.authenticate) {
      try {
        const ok = await route.handlers.authenticate(upgradeContext);
        if (!ok) {
          return {
            accepted: false,
            response: new Response(
              JSON.stringify({ error: { code: 'UNAUTHORIZED', message: 'WebSocket authentication required' } }),
              {
                status: 401,
                headers: { 'content-type': 'application/json; charset=utf-8' },
              },
            ),
          };
        }
      } catch (err: unknown) {
        const status = isForgeError(err) ? err.statusCode : 401;
        const normalized = normalizeError(err);
        return {
          accepted: false,
          response: new Response(
            JSON.stringify(normalized.toPublicJSON({ production: true })),
            {
              status,
              headers: { 'content-type': 'application/json; charset=utf-8' },
            },
          ),
        };
      }
    }

    return {
      accepted: true,
      route,
      upgradeContext,
    };
  }
}
