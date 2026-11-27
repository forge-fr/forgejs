# WebSockets & Server-Sent Events

> Cross-runtime app.ws() (RFC 6455 Node, native Bun.serve, Edge) with pre-upgrade auth, CSWSH allowedOrigins, and createSseResponse() streaming.

- **Section**: Advanced Features
- **Packages**: @forge-fr/http, @forge-fr/node, @forge-fr/bun, @forge-fr/edge
- **Version**: v1.0.0-rc.2
- **Updated**: 2026-11-26
- **HTML URL**: https://github.com/forge-fr/forgejs/docs/advanced/realtime
- **Markdown URL**: https://github.com/forge-fr/forgejs/docs/advanced/realtime.md
- **Source**: https://github.com/forge-fr/forgejs/blob/main/docs/http-and-validation.md

## Pre-upgrade WebSocket security & SSE streaming

app.ws(path, handlers, options) validates Origin allowlists (preventing Cross-Site WebSocket Hijacking) and executes authenticate(ctx) before sending 101 Switching Protocols.

**File: `src/realtime.ts`**

```ts
import { createHttpApp, createSseResponse } from '@forge-fr/http';

const app = createHttpApp();

app.ws(
  '/ws/chat/:room',
  {
    authenticate(ctx) {
      return ctx.headers.get('authorization') === 'Bearer secret';
    },
    onOpen(ws) {
      ws.send(`joined:${ws.params['room']}`);
    },
    onMessage(ws, message) {
      ws.send(`echo:${String(message)}`);
    },
  },
  {
    allowedOrigins: ['https://app.example.com'],
    maxPayloadBytes: 64 * 1024,
  },
);

app.get('/events', () =>
  createSseResponse(async (stream) => {
    await stream.send({ event: 'ready', data: { ok: true } });
    stream.close();
  }),
);
```
