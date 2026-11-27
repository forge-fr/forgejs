import type { ForgeHttpApp } from '@forge-fr/http';
import { OpenApiError } from './errors.js';
import { generateOpenApiDocument } from './generator.js';
import type { RegisterOpenApiRoutesOptions, SwaggerUiOptions } from './types.js';

const DEFAULT_SWAGGER_UI_DIST = 'https://cdn.jsdelivr.net/npm/swagger-ui-dist@5';

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
    <link rel="stylesheet" href="${safeAssetBaseAttr}/swagger-ui.css" />
  </head>
  <body>
    <div id="swagger-ui"></div>
    <script src="${safeAssetBaseAttr}/swagger-ui-bundle.js"></script>
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

export function registerOpenApiRoutes(
  app: ForgeHttpApp,
  options: RegisterOpenApiRoutesOptions,
): void {
  if (options.enabled === false) {
    return;
  }

  const specPath = options.specPath ?? '/openapi.json';
  const docsPath = options.docsPath ?? '/docs';
  const assetBase = assertSafeAssetBaseUrl(
    options.ui?.swaggerUiDistUrl ?? DEFAULT_SWAGGER_UI_DIST,
  );
  const scriptOrigin = assetBase.startsWith('https://') ? new URL(assetBase).origin : "'self'";
  const cspHeader = buildSwaggerCspHeader(scriptOrigin);

  app.get(specPath, (ctx) => {
    const doc = generateOpenApiDocument(app, {
      ...options,
      excludePaths: [...(options.excludePaths ?? []), specPath, docsPath],
    });
    ctx.setHeader('cache-control', 'no-store');
    return ctx.json(doc);
  });

  app.get(docsPath, (ctx) => {
    const html = renderSwaggerUiHtml(specPath, {
      title: options.ui?.title ?? options.title,
      swaggerUiDistUrl: assetBase,
      ...(options.ui?.persistAuthorization !== undefined
        ? { persistAuthorization: options.ui.persistAuthorization }
        : {}),
    });
    ctx.setHeader('content-security-policy', cspHeader);
    ctx.setHeader('x-content-type-options', 'nosniff');
    ctx.setHeader('x-frame-options', 'DENY');
    ctx.setHeader('referrer-policy', 'no-referrer');
    return ctx.html(html);
  });
}
