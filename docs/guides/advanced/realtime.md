# WebSockets & Server-Sent Events

> Add real-time WebSockets (app.ws()) with pre-upgrade authentication and Origin checks, plus Server-Sent Events streaming.

- **Section**: Advanced Features
- **Packages**: @forge-fr/http, @forge-fr/node, @forge-fr/bun, @forge-fr/edge
- **Version**: v1.0.0
- **Updated**: 2026-11-27
- **HTML URL**: https://github.com/forge-fr/forgejs/docs/advanced/realtime
- **Markdown URL**: https://github.com/forge-fr/forgejs/docs/advanced/realtime.md
- **Source**: https://github.com/forge-fr/forgejs/blob/main/docs/http-and-validation.md

## Authenticated WebSockets & SSE event streams

app.ws(path, handlers, options) checks the allowedOrigins list (blocking cross-site WebSocket hijacking) and runs your authenticate(ctx) function before accepting the WebSocket upgrade.

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
