import { createHttpApp } from '@forge-fr/http';
import { createMemoryWebSocketPair } from '@forge-fr/testing';
import { describe, expect, it } from 'vitest';

describe('@forge-fr/http — WebSocket Routing, CSWSH Origin Guard, Pre-Upgrade Auth & Frame Limits', () => {
  it('matches parameterized WebSocket routes, enforces CSWSH Origin allowlist, and blocks unauthenticated upgrades pre-101', async () => {
    const app = createHttpApp();
    const events: string[] = [];

    app.ws(
      '/ws/rooms/:roomId',
      {
        authenticate(ctx) {
          return ctx.headers.get('authorization') === 'Bearer valid-token';
        },
        onOpen(ws) {
          events.push(`open:${ws.params['roomId']}`);
          ws.send(JSON.stringify({ joined: ws.params['roomId'] }));
        },
        onMessage(ws, message) {
          events.push(`msg:${typeof message === 'string' ? message : 'binary'}`);
          if (typeof message === 'string') {
            ws.send(`echo:${message}`);
          } else {
            ws.send(message);
          }
        },
        onClose(_ws, info) {
          events.push(`close:${info.code}`);
        },
      },
      {
        allowedOrigins: ['https://app.example.com'],
        maxPayloadBytes: 32,
      },
    );

    // 1. Cross-Site WebSocket Hijacking (Origin mismatch) rejected with 403 before 101
    const badOriginResult = await app.authorizeWebSocketUpgrade(
      new Request('http://localhost/ws/rooms/general', {
        headers: {
          upgrade: 'websocket',
          connection: 'Upgrade',
          origin: 'https://evil.attacker.example',
          authorization: 'Bearer valid-token',
        },
      }),
    );
    expect(badOriginResult.accepted).toBe(false);
    if (!badOriginResult.accepted) {
      expect(badOriginResult.response.status).toBe(403);
    }

    // 2. Missing/invalid credential rejected with 401 before 101
    const unauthResult = await app.authorizeWebSocketUpgrade(
      new Request('http://localhost/ws/rooms/general', {
        headers: {
          upgrade: 'websocket',
          connection: 'Upgrade',
          origin: 'https://app.example.com',
        },
      }),
    );
    expect(unauthResult.accepted).toBe(false);
    if (!unauthResult.accepted) {
      expect(unauthResult.response.status).toBe(401);
    }

    // 3. Valid upgrade opens session via memory pair & enforces maxPayloadBytes (1009)
    const validResult = await app.authorizeWebSocketUpgrade(
      new Request('http://localhost/ws/rooms/alpha', {
        headers: {
          upgrade: 'websocket',
          connection: 'Upgrade',
          origin: 'https://app.example.com',
          authorization: 'Bearer valid-token',
        },
      }),
    );
    expect(validResult.accepted).toBe(true);
    if (validResult.accepted) {
      const { client, attachServer } = createMemoryWebSocketPair();
      const received: Array<string | Uint8Array> = [];
      client.onMessage((msg) => received.push(msg));
      let closeCode = 0;
      client.onClose((info) => {
        closeCode = info.code;
      });

      attachServer(validResult.route, validResult.upgradeContext);
      expect(received[0]).toBe('{"joined":"alpha"}');

      client.send('hi');
      expect(received[1]).toBe('echo:hi');

      // Oversized payload triggers close code 1009 (Message Too Big)
      client.send('x'.repeat(64));
      expect(closeCode).toBe(1009);
      expect(events).toContain('open:alpha');
      expect(events).toContain('close:1009');
    }
  });
});
