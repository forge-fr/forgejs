# @forge-fr/http

> Web-standard HTTP server with typed ContextKey<T> state, layered middleware, streaming multipart/binary body readers, SSE/WebSocket pub-sub RealtimeHub, compression, and ETags.

- **Version**: v1.0.0
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
# Add once to .npmrc: @forge-fr:registry=https://npm.pkg.github.com
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

- **Values**: `createHttpApp`, `createContextKey`, `isContextKey`, `composeMiddleware`, `sortMiddleware`, `createCompressionMiddleware`, `createEtagMiddleware`
- **Types**: `AnyContextKey`, `ContextKey`, `ContextKeyOptions`, `DefaultedContextKey`, `ForgeHttpApp`, `ForgeContext`, `ForgeMiddleware`, `ForgeRouteHandler`, `HttpAppOptions`, `HttpGroupOptions`, `HttpMethod`, `HttpRouteOptions`, `HttpRuntimeAdapter`, `ListenOptions`, `MiddlewareNext`, `MiddlewareRegistrationOptions`, `MiddlewareTier`, `RegisteredMiddleware`, `RegisteredRoute`, `ResponseHelperInit`, `RouteHandlerResult`, `ServerAddress`, `CompressionOptions`, `SupportedCompressionEncoding`, `EtagOptions`, `FetchHandler`, `RedirectStatusCode`, `RuntimeRequestMeta`

### Fast Path, Body Parsers, Negotiation & SSE

- **Values**: `FastHeaders`, `FastResponse`, `attachFastBody`, `copyFastBody`, `createFastResponse`, `getFastBody`, `toNativeResponse`, `DEFAULT_MAX_BODY_BYTES`, `DEFAULT_MAX_MULTIPART_BYTES`, `DEFAULT_MAX_MULTIPART_FIELDS`, `DEFAULT_MAX_MULTIPART_FILES`, `DEFAULT_MAX_MULTIPART_FILE_BYTES`, `readBoundedBytes`, `readBoundedJson`, `readBoundedMultipart`, `readBoundedText`, `readBoundedUrlEncoded`, `readMultipartStream`, `sanitizeUploadFilename`, `verifyUploadMagicBytes`, `formatContentDisposition`, `negotiateContentType`, `parseAcceptHeader`, `createSseEventBuffer`, `createSseResponse`, `extractLastEventId`, `formatSseEvent`
- **Types**: `BodyParseOptions`, `BinaryBodyInput`, `BinaryResponseOptions`, `ContentDispositionType`, `DownloadResponseOptions`, `MultipartParseOptions`, `MultipartStreamFieldPart`, `MultipartStreamFilePart`, `MultipartStreamOptions`, `MultipartStreamPart`, `ParsedMultipart`, `UploadValidationRules`, `UploadedFile`, `RequestBodyReader`, `AcceptMediaRange`, `BufferedSseEvent`, `CreateSseResponseOptions`, `ExtractLastEventIdSource`, `SseEvent`, `SseEventBuffer`, `SseEventBufferOptions`, `SseProducer`, `SseResponseOptions`, `SseStreamController`

### Hooks, WebSockets, Realtime Hub & HTTP Errors

- **Values**: `DEFAULT_WS_MAX_PAYLOAD_BYTES`, `WebSocketRouteRegistry`, `createWebSocketConnection`, `createWebSocketUpgradeContext`, `DEFAULT_HEARTBEAT_INTERVAL_MS`, `DEFAULT_PONG_TIMEOUT_MS`, `DEFAULT_REALTIME_MAX_BUFFERED_BYTES`, `DEFAULT_REALTIME_MAX_PENDING_MESSAGES`, `RealtimeBackpressureError`, `createEventDispatcherRealtimeBridge`, `createMemoryRealtimePubSubAdapter`, `createMemoryRealtimePubSubBus`, `createRealtimeHub`, `createRedisRealtimePubSubAdapter`, `createWebSocketHeartbeat`, `withRealtimeWebSocket`, `BadRequestError`, `ContextKeyNotFoundError`, `ForgeHttpError`, `ForgeMiddlewareError`, `MethodNotAllowedError`, `NotAcceptableError`, `PayloadTooLargeError`, `ResponseCommittedError`, `UnsupportedMediaTypeError`
- **Types**: `HttpHookHandlerMap`, `HttpHookName`, `HttpHookOptions`, `OnErrorHookPayload`, `OnRequestHookPayload`, `OnResponseHookPayload`, `OnSendHookPayload`, `PreHandlerHookPayload`, `PreSerializationHookPayload`, `PreValidationHookPayload`, `ForgeHttpErrorOptions`, `MiddlewareErrorCode`, `CreateWebSocketConnectionTransport`, `CreateWebSocketUpgradeContextInit`, `RegisteredWebSocketRoute`, `WebSocketCloseInfo`, `WebSocketConnection`, `WebSocketHandlers`, `WebSocketMessageData`, `WebSocketRouteOptions`, `WebSocketUpgradeCheckResult`, `WebSocketUpgradeContext`, `BackpressureStrategy`, `EventDispatcherRealtimeBridgeHandle`, `EventDispatcherRealtimeBridgeOptions`, `EventDispatcherRoomMapper`, `MemoryRealtimePubSubBus`, `RealtimeBroadcastOptions`, `RealtimeBroadcastResult`, `RealtimeHub`, `RealtimeHubOptions`, `RealtimePresenceEntry`, `RealtimePubSubAdapter`, `RealtimePubSubEnvelope`, `RealtimePubSubListener`, `RealtimeSendOptions`, `RealtimeSendResult`, `RedisPubSubPublisherLike`, `RedisPubSubSubscriberLike`, `RedisRealtimePubSubOptions`, `SseHubSubscriptionOptions`, `WebSocketHeartbeatManager`, `WebSocketHeartbeatOptions`
