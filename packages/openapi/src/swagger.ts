import type { ForgeHttpApp } from '@forge-fr/http';
import { OpenApiError } from './errors.js';
import { generateOpenApiDocument } from './generator.js';
import type { OpenApiDocument, RegisterOpenApiRoutesOptions, SwaggerUiOptions } from './types.js';

export const DEFAULT_SWAGGER_UI_DIST = 'https://cdn.jsdelivr.net/npm/swagger-ui-dist@5.18.2';

function escapeHtml(raw: string): string {
  return raw
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeJsonForInlineScript(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

function assertSafeAssetBaseUrl(rawUrl: string): string {
  if (rawUrl.startsWith('/')) {
    return rawUrl.replace(/\/+$/, '');
  }
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new OpenApiError(`Invalid Swagger UI asset base URL "${rawUrl}"`, {
      statusCode: 400,
      expose: true,
    });
  }
  if (parsed.protocol !== 'https:') {
    throw new OpenApiError('Swagger UI remote asset base URL must use https://', {
      statusCode: 400,
      expose: true,
    });
  }
  return rawUrl.replace(/\/+$/, '');
}

export function renderSwaggerUiHtml(
  specUrl: string,
  options: SwaggerUiOptions = {},
): string {
  const title = escapeHtml(options.title ?? 'ForgeJS API Documentation');
  const assetBase = assertSafeAssetBaseUrl(
    options.swaggerUiDistUrl ?? DEFAULT_SWAGGER_UI_DIST,
  );
  const safeAssetBaseAttr = escapeHtml(assetBase);
  const styleIntegrityAttr =
    typeof options.styleIntegrity === 'string' && options.styleIntegrity.length > 0
      ? ` integrity="${escapeHtml(options.styleIntegrity)}" crossorigin="anonymous"`
      : '';
  const scriptIntegrityAttr =
    typeof options.scriptIntegrity === 'string' && options.scriptIntegrity.length > 0
      ? ` integrity="${escapeHtml(options.scriptIntegrity)}" crossorigin="anonymous"`
      : '';
  const safeConfigJson = escapeJsonForInlineScript({
    url: specUrl,
    persistAuthorization: options.persistAuthorization === true,
  });

  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${title}</title>
    <link rel="stylesheet" href="${safeAssetBaseAttr}/swagger-ui.css"${styleIntegrityAttr} />
  </head>
  <body>
    <div id="swagger-ui"></div>
    <script src="${safeAssetBaseAttr}/swagger-ui-bundle.js"${scriptIntegrityAttr}></script>
    <script>
      globalThis.addEventListener('DOMContentLoaded', function () {
        const cfg = ${safeConfigJson};
        globalThis.ui = SwaggerUIBundle({
          url: cfg.url,
          dom_id: '#swagger-ui',
          deepLinking: true,
          persistAuthorization: cfg.persistAuthorization,
        });
      });
    </script>
  </body>
</html>`;
}

function buildSwaggerCspHeader(assetOriginOrSelf: string): string {
  return [
    "default-src 'none'",
    `script-src ${assetOriginOrSelf} 'unsafe-inline'`,
    `style-src ${assetOriginOrSelf} 'unsafe-inline'`,
    "img-src 'self' data:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
}

function resolveRuntimeEnvironment(explicitEnv?: string): string | undefined {
  if (typeof explicitEnv === 'string' && explicitEnv.length > 0) {
    return explicitEnv;
  }
  const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
  return proc?.env?.['NODE_ENV'];
}

export function registerOpenApiRoutes(
  app: ForgeHttpApp,
  options: RegisterOpenApiRoutesOptions,
): void {
  if (options.enabled === false) {
    return;
  }

  const runtimeEnv = resolveRuntimeEnvironment(options.environment);
  if (options.exposeInProduction === false && runtimeEnv === 'production') {
    return;
  }

  const specPath = options.specPath ?? '/openapi.json';
  const docsPath = options.docsPath ?? '/docs';
  const assetBase = assertSafeAssetBaseUrl(
    options.ui?.swaggerUiDistUrl ?? DEFAULT_SWAGGER_UI_DIST,
  );
  const scriptOrigin = assetBase.startsWith('https://') ? new URL(assetBase).origin : "'self'";
  const cspHeader = buildSwaggerCspHeader(scriptOrigin);

  const shouldCache = options.cacheSpec !== false;
  let cachedDoc: OpenApiDocument | undefined;
  let cachedRouteCount = -1;

  const getDocument = (): OpenApiDocument => {
    const currentRouteCount = app.routes().length;
    if (shouldCache && cachedDoc !== undefined && cachedRouteCount === currentRouteCount) {
      return cachedDoc;
    }
    const doc = generateOpenApiDocument(app, {
      ...options,
      excludePaths: [...(options.excludePaths ?? []), specPath, docsPath],
    });
    if (shouldCache) {
      cachedDoc = doc;
      cachedRouteCount = currentRouteCount;
    }
    return doc;
  };

  const cachedHtml = renderSwaggerUiHtml(specPath, {
    title: options.ui?.title ?? options.title,
    swaggerUiDistUrl: assetBase,
    ...(options.ui?.scriptIntegrity !== undefined
      ? { scriptIntegrity: options.ui.scriptIntegrity }
      : {}),
    ...(options.ui?.styleIntegrity !== undefined
      ? { styleIntegrity: options.ui.styleIntegrity }
      : {}),
    ...(options.ui?.persistAuthorization !== undefined
      ? { persistAuthorization: options.ui.persistAuthorization }
      : {}),
  });

  const routeOptions =
    options.middleware && options.middleware.length > 0
      ? { middleware: [...options.middleware] }
      : undefined;

  app.get(
    specPath,
    async (ctx) => {
      if (options.authorize) {
        const allowed = await options.authorize(ctx);
        if (!allowed) {
          throw new OpenApiError('OpenAPI documentation access denied', {
            statusCode: 403,
            expose: true,
          });
        }
      }
      const doc = getDocument();
      ctx.setHeader('cache-control', 'no-store');
      return ctx.json(doc);
    },
    routeOptions,
  );

  app.get(
    docsPath,
    async (ctx) => {
      if (options.authorize) {
        const allowed = await options.authorize(ctx);
        if (!allowed) {
          throw new OpenApiError('OpenAPI documentation access denied', {
            statusCode: 403,
            expose: true,
          });
        }
      }
      ctx.setHeader('content-security-policy', cspHeader);
      ctx.setHeader('x-content-type-options', 'nosniff');
      ctx.setHeader('x-frame-options', 'DENY');
      ctx.setHeader('referrer-policy', 'no-referrer');
      return ctx.html(cachedHtml);
    },
    routeOptions,
  );
}
