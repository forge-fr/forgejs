# @forge-fr/http

> Web Standards HTTP engine with tiered middleware, 7 lifecycle hooks, bounded body parsers, SSE, Web Streams compression, conditional ETags, and WebSocket route registry.

- **Version**: v1.0.0-rc.2
- **Layer**: Framework Core
- **Category**: core
- **Tarball**: 52.5 kB (56 files)
- **Internal deps**: @forge-fr/core, @forge-fr/router
- **Runtime deps**: zero runtime dependencies
- **Peer deps**: none
- **HTML URL**: https://github.com/forge-fr/forgejs/api/http
- **Markdown URL**: https://github.com/forge-fr/forgejs/api/http.md

## Installation

```bash
npm install @forge-fr/http
```

## Runtime & Error Semantics

- **Runtime**: Built on Web Standards (Request, Response, Headers, ReadableStream, CompressionStream). Zero third-party dependencies; automatically emits native globalThis.Response on Cloudflare Workers, Deno, and Bun.
- **Errors**: Enforces 1 MiB default body limit (PayloadTooLargeError 413), CR/LF/NUL rejection in FastHeaders, and double-next() / post-commit middleware guards.

## Usage Example

```ts
import { createHttpApp, createCompressionMiddleware, createEtagMiddleware } from '@forge-fr/http';

const app = createHttpApp();
app.use(createCompressionMiddleware());
app.use(createEtagMiddleware());

app.get('/ping', (ctx) => ctx.json({ pong: true }));
```

## Public Exports

### Application & Middleware

- **Values**: `createHttpApp`, `composeMiddleware`, `sortMiddleware`, `createCompressionMiddleware`, `createEtagMiddleware`
- **Types**: `ForgeHttpApp`, `ForgeContext`, `ForgeMiddleware`, `ForgeRouteHandler`, `HttpAppOptions`, `HttpGroupOptions`, `HttpMethod`, `HttpRouteOptions`, `HttpRuntimeAdapter`, `ListenOptions`, `MiddlewareNext`, `MiddlewareRegistrationOptions`, `MiddlewareTier`, `RegisteredMiddleware`, `RegisteredRoute`, `ResponseHelperInit`, `RouteHandlerResult`, `ServerAddress`, `CompressionOptions`, `SupportedCompressionEncoding`, `EtagOptions`, `FetchHandler`, `RedirectStatusCode`, `RuntimeRequestMeta`

### Fast Path, Body Parsers, Negotiation & SSE

- **Values**: `FastHeaders`, `FastResponse`, `attachFastBody`, `copyFastBody`, `createFastResponse`, `getFastBody`, `toNativeResponse`, `DEFAULT_MAX_BODY_BYTES`, `DEFAULT_MAX_MULTIPART_FIELDS`, `DEFAULT_MAX_MULTIPART_FILES`, `DEFAULT_MAX_MULTIPART_FILE_BYTES`, `readBoundedBytes`, `readBoundedJson`, `readBoundedMultipart`, `readBoundedText`, `readBoundedUrlEncoded`, `negotiateContentType`, `parseAcceptHeader`, `createSseResponse`, `formatSseEvent`
- **Types**: `BodyParseOptions`, `ParsedMultipart`, `UploadedFile`, `RequestBodyReader`, `AcceptMediaRange`, `CreateSseResponseOptions`, `SseEvent`, `SseProducer`, `SseStreamController`

### Hooks, WebSockets & HTTP Errors

- **Values**: `DEFAULT_WS_MAX_PAYLOAD_BYTES`, `WebSocketRouteRegistry`, `BadRequestError`, `ForgeHttpError`, `ForgeMiddlewareError`, `MethodNotAllowedError`, `NotAcceptableError`, `PayloadTooLargeError`, `ResponseCommittedError`, `UnsupportedMediaTypeError`
- **Types**: `HttpHookHandlerMap`, `HttpHookName`, `HttpHookOptions`, `OnErrorHookPayload`, `OnRequestHookPayload`, `OnResponseHookPayload`, `OnSendHookPayload`, `PreHandlerHookPayload`, `PreSerializationHookPayload`, `PreValidationHookPayload`, `ForgeHttpErrorOptions`, `MiddlewareErrorCode`, `RegisteredWebSocketRoute`, `WebSocketCloseInfo`, `WebSocketConnection`, `WebSocketHandlers`, `WebSocketMessageData`, `WebSocketRouteOptions`, `WebSocketUpgradeCheckResult`, `WebSocketUpgradeContext`
