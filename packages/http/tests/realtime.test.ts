import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { createEventDispatcher } from '@forge-fr/core';
import {
  AuthIdentityKey,
  createArgon2PasswordHasher,
  createAuthIdentity,
  createWebCryptoPasswordHasher,
  type AuthIdentity,
} from '@forge-fr/auth';
import {
  ContextKeyNotFoundError,
  createContextKey,
  createHttpApp,
  type WebSocketConnection,
  type WebSocketMessageData,
} from '@forge-fr/http';
import {
  RealtimeBackpressureError,
  createEventDispatcherRealtimeBridge,
  createMemoryRealtimePubSubBus,
  createRealtimeHub,
  createRedisRealtimePubSubAdapter,
  createSseEventBuffer,
  createWebSocketConnection,
  createWebSocketHeartbeat,
  createWebSocketUpgradeContext,
  extractLastEventId,
  withRealtimeWebSocket,
} from '@forge-fr/http/realtime';
import {
  createCloudflareWorkerHandler,
  createDenoHandler,
  type EdgeServerWebSocketLike,
  type EdgeWebSocketPairLike,
} from '@forge-fr/edge';
import { createTestClient } from '@forge-fr/testing';

function createMockWsConnection(options: {
  readonly id?: string;
  readonly bufferedAmount?: () => number;
  readonly upgradeRequest?: Request;
} = {}): {
  readonly conn: WebSocketConnection;
  readonly sent: WebSocketMessageData[];
  readonly pings: (WebSocketMessageData | undefined)[];
  readonly closeCalls: Array<{ code: number; reason: string }>;
  setReadyState(state: 'open' | 'closing' | 'closed'): void;
} {
  let state: 'open' | 'closing' | 'closed' = 'open';
  const sent: WebSocketMessageData[] = [];
  const pings: (WebSocketMessageData | undefined)[] = [];
  const closeCalls: Array<{ code: number; reason: string }> = [];
  const req = options.upgradeRequest ?? new Request('http://localhost/ws/rooms/general');
  const url = new URL(req.url);

  const upgradeCtx = createWebSocketUpgradeContext({
    request: req,
    url,
    path: url.pathname,
    headers: req.headers,
    params: { room: 'general' },
    query: {},
    runtime: 'memory',
    protocol: '',
  });

  const conn = createWebSocketConnection(upgradeCtx, {
    ...(options.id !== undefined ? { id: options.id } : {}),
    getReadyState: () => state,
    ...(options.bufferedAmount !== undefined ? { getBufferedAmount: options.bufferedAmount } : {}),
    send(data) {
      if (state === 'open') {
        sent.push(data);
      }
    },
    close(code = 1000, reason = '') {
      if (state !== 'open') return;
      state = 'closed';
      closeCalls.push({ code, reason });
    },
    ping(data) {
      if (state === 'open') {
        pings.push(data);
      }
    },
  });

  return {
    conn,
    sent,
    pings,
    closeCalls,
    setReadyState(next) {
      state = next;
    },
  };
}

describe('Milestone 6 — Edge Portability (Part 13) & Real-Time Architecture (@forge-fr/http/realtime, Part 14)', () => {
  it('verifies zero static top-level @node-rs/argon2 or postgres runtime imports and zero wrangler.jsonc alias hacks (Part 13)', async () => {
    const rootDir = path.resolve(import.meta.dirname, '../../..');
    const authPasswordSrc = fs.readFileSync(
      path.join(rootDir, 'packages/auth/src/password.ts'),
      'utf8',
    );
    const dbPostgresSrc = fs.readFileSync(
      path.join(rootDir, 'packages/database/src/postgres.ts'),
      'utf8',
    );
    const wranglerJsonc = fs.readFileSync(path.join(rootDir, 'wrangler.jsonc'), 'utf8');

    // Only type-only import is permitted at top-level; value import must be lazy
    expect(authPasswordSrc).not.toMatch(/import\s+\{[^}]*hash[^}]*\}\s+from\s+['"]@node-rs\/argon2['"]/);
    expect(dbPostgresSrc).not.toMatch(/import\s+postgres\s+from\s+['"]postgres['"]/);
    expect(wranglerJsonc).not.toContain('"alias"');
    expect(wranglerJsonc).not.toContain('argon2-edge-stub');

    // Pure Web Crypto PBKDF2-SHA256 hasher works on any WinterCG Edge / Node / Bun runtime
    const edgeHasher = createWebCryptoPasswordHasher({ iterations: 5_000 });
    const hashed = await edgeHasher.hash('edge-portable-secret-password');
    expect(hashed.startsWith('$pbkdf2-sha256$i=5000$')).toBe(true);
    expect(await edgeHasher.verify('edge-portable-secret-password', hashed)).toBe(true);
    expect(await edgeHasher.verify('wrong-password', hashed)).toBe(false);
    expect(edgeHasher.needsRehash(hashed)).toBe(false);

    const strongerHasher = createWebCryptoPasswordHasher({ iterations: 10_000 });
    expect(strongerHasher.needsRehash(hashed)).toBe(true);

    // Argon2 hasher with backend: 'webcrypto' and cross-verification of $pbkdf2-sha256$ hashes
    const autoHasher = createArgon2PasswordHasher({
      backend: 'webcrypto',
      webCryptoIterations: 5_000,
    });
    const autoHash = await autoHasher.hash('portable-pass');
    expect(autoHash.startsWith('$pbkdf2-sha256$')).toBe(true);
    expect(await autoHasher.verify('portable-pass', autoHash)).toBe(true);
  });

  it('propagates typed ContextKey<T> state from WebSocketUpgradeContext (authenticate) to WebSocketConnection across Edge/Cloudflare & Deno', async () => {
    const TenantKey = createContextKey<{ readonly tenantId: string; readonly plan: 'pro' | 'free' }>(
      'ws.tenant',
    );
    const DefaultedRoleKey = createContextKey<string>('ws.role', {
      defaultValue: () => 'viewer',
    });
    const MissingKey = createContextKey<number>('ws.missing');

    const observedMessages: Array<{
      subject: string;
      tenantId: string;
      role: string;
      payload: string;
    }> = [];

    const app = createHttpApp();
    app.ws('/ws/tenant/:tenantId', {
      authenticate(ctx) {
        const token = ctx.headers.get('x-ws-token');
        if (token !== 'valid-secret') {
          return false;
        }
        const identity = createAuthIdentity({
          subject: 'user_42',
          method: 'jwt',
          roles: ['editor'],
        });
        ctx.set(AuthIdentityKey, identity);
        ctx.set(TenantKey, {
          tenantId: ctx.params['tenantId'] ?? 'unknown',
          plan: 'pro',
        });
        expect(ctx.has(AuthIdentityKey)).toBe(true);
        expect(ctx.has(MissingKey)).toBe(false);
        return true;
      },
      onOpen(ws, upgradeCtx) {
        const auth = ws.require(AuthIdentityKey);
        const tenant = ws.require(TenantKey);
        const role = ws.get(DefaultedRoleKey);

        expectTypeOf(auth).toEqualTypeOf<AuthIdentity>();
        expectTypeOf(tenant).toEqualTypeOf<{ readonly tenantId: string; readonly plan: 'pro' | 'free' }>();
        expectTypeOf(role).toEqualTypeOf<string>();

        expect(auth.subject).toBe('user_42');
        expect(tenant.tenantId).toBe('acme');
        expect(role).toBe('viewer');
        expect(upgradeCtx.get(TenantKey)?.plan).toBe('pro');
        expect(() => ws.require(MissingKey)).toThrow(ContextKeyNotFoundError);

        ws.set(DefaultedRoleKey, 'admin');
      },
      onMessage(ws, message) {
        const auth = ws.require(AuthIdentityKey);
        const tenant = ws.require(TenantKey);
        const role = ws.get(DefaultedRoleKey);
        observedMessages.push({
          subject: auth.subject,
          tenantId: tenant.tenantId,
          role,
          payload: typeof message === 'string' ? message : new TextDecoder().decode(message),
        });
        ws.sendJson?.({ ack: true, role, tenant: tenant.tenantId });
      },
    });

    // Test via Cloudflare Worker handler with custom WebSocketPair
    let serverSocket: EdgeServerWebSocketLike | null = null;
    const sentFrames: Array<string | ArrayBuffer | Uint8Array> = [];

    class MockWebSocketPair implements EdgeWebSocketPairLike {
      public readonly 0: unknown = { kind: 'client-socket' };
      public readonly 1: EdgeServerWebSocketLike;

      public constructor() {
        const listeners = new Map<string, Array<(ev: unknown) => void>>();
        const srv: EdgeServerWebSocketLike = {
          accept() {},
          send(data) {
            sentFrames.push(data);
          },
          close() {},
          addEventListener(type, listener) {
            const list = listeners.get(type) ?? [];
            list.push(listener);
            listeners.set(type, list);
          },
        };
        (srv as { emit?: (type: string, ev: unknown) => void }).emit = (type: string, ev: unknown) => {
          for (const fn of listeners.get(type) ?? []) {
            fn(ev);
          }
        };
        this[1] = srv;
        serverSocket = srv;
      }
    }

    const worker = createCloudflareWorkerHandler(app, {
      webSocketPair: MockWebSocketPair,
    });

    // Unauthorized upgrade rejected with 401
    const deniedRes = await worker.fetch(
      new Request('https://forgejs.id/ws/tenant/acme', {
        headers: { upgrade: 'websocket', 'x-ws-token': 'bad' },
      }),
    );
    expect(deniedRes.status).toBe(401);

    // Authorized upgrade succeeds with 101 and propagates typed context keys
    const upgradeRes = await worker.fetch(
      new Request('https://forgejs.id/ws/tenant/acme', {
        headers: { upgrade: 'websocket', 'x-ws-token': 'valid-secret' },
      }),
    );
    expect(upgradeRes.status).toBe(101);
    expect(serverSocket).not.toBeNull();

    (serverSocket as unknown as { emit(type: string, ev: unknown): void }).emit('message', {
      data: 'hello-realtime',
    });

    await new Promise((r) => setTimeout(r, 10));
    expect(observedMessages).toEqual([
      {
        subject: 'user_42',
        tenantId: 'acme',
        role: 'admin',
        payload: 'hello-realtime',
      },
    ]);
    expect(sentFrames).toHaveLength(1);
    expect(JSON.parse(String(sentFrames[0]))).toEqual({
      ack: true,
      role: 'admin',
      tenant: 'acme',
    });

    // Also verify Deno upgradeWebSocket handler
    let denoSocket: EdgeServerWebSocketLike | null = null;
    const denoHandler = createDenoHandler(app, {
      upgradeWebSocket: () => {
        const sock: EdgeServerWebSocketLike = {
          send() {},
          close() {},
        };
        denoSocket = sock;
        return { response: new Response(null, { status: 200 }), socket: sock };
      },
    });
    const denoRes = await denoHandler(
      new Request('http://localhost/ws/tenant/beta', {
        headers: { upgrade: 'websocket', 'x-ws-token': 'valid-secret' },
      }),
    );
    expect(denoRes.status).toBe(200);
    expect(denoSocket).not.toBeNull();
  });

  it('manages rooms, presence, targeted messaging, exclusions, and cross-node pub-sub (Memory Bus & Redis Adapter)', async () => {
    // 1. Shared memory pub/sub bus across two RealtimeHub nodes (Node A & Node B)
    const bus = createMemoryRealtimePubSubBus();
    const hubA = createRealtimeHub({ nodeId: 'node-a', pubSub: bus.createAdapter('node-a') });
    const hubB = createRealtimeHub({ nodeId: 'node-b', pubSub: bus.createAdapter('node-b') });

    const clientA1 = createMockWsConnection({ id: 'conn-a1' });
    const clientA2 = createMockWsConnection({ id: 'conn-a2' });
    const clientB1 = createMockWsConnection({ id: 'conn-b1' });

    await hubA.join('chat:lobby', clientA1.conn, { username: 'alice', cursor: { x: 10, y: 20 } });
    await hubA.join('chat:lobby', clientA2.conn, { username: 'bob' });
    await hubB.join('chat:lobby', clientB1.conn, { username: 'charlie' });

    expect(hubA.rooms()).toEqual(['chat:lobby']);
    expect(hubA.roomSize('chat:lobby')).toBe(2);
    expect(hubA.isMember('chat:lobby', 'conn-a1')).toBe(true);
    expect(hubA.getPresence('chat:lobby')).toHaveLength(2);

    hubA.updatePresence('chat:lobby', 'conn-a1', { status: 'typing' });
    const alicePresence = hubA.getPresence('chat:lobby').find((p) => p.connectionId === 'conn-a1');
    expect(alicePresence?.metadata).toEqual({
      username: 'alice',
      cursor: { x: 10, y: 20 },
      status: 'typing',
    });

    // Broadcast from Node A excluding sender conn-a1 -> delivered to conn-a2 locally AND conn-b1 on Node B!
    const bcastRes = await hubA.broadcast(
      'chat:lobby',
      { type: 'chat.message', text: 'Hello across nodes!' },
      { exclude: 'conn-a1', event: 'chat.message' },
    );

    expect(bcastRes.deliveredWebSockets).toBe(1); // conn-a2 on Node A
    expect(clientA1.sent).toHaveLength(0); // excluded
    expect(clientA2.sent).toHaveLength(1);
    expect(clientB1.sent).toHaveLength(1); // bridged to Node B without looping back to Node A!
    expect(JSON.parse(String(clientB1.sent[0]))).toEqual({
      type: 'chat.message',
      text: 'Hello across nodes!',
    });

    // Binary Uint8Array broadcast bridges cleanly across nodes via base64 envelope
    await hubB.broadcast('chat:lobby', new Uint8Array([1, 2, 3, 4]));
    expect(clientA1.sent).toHaveLength(1);
    expect(clientA1.sent[0]).toEqual(new Uint8Array([1, 2, 3, 4]));

    // 2. Structural Redis Pub/Sub Adapter verification
    const redisChannels = new Map<string, Set<(channel: string, message: string) => void>>();
    const emitterListeners = new Set<(channel: string, message: string) => void>();

    const mockRedisPublisher = {
      async publish(channel: string, message: string) {
        const subs = redisChannels.get(channel);
        if (subs) {
          for (const fn of subs) {
            fn(channel, message);
          }
        }
      },
    };

    const createMockRedisSubscriber = () => {
      const localListeners = new Set<(channel: string, message: string) => void>();
      return {
        on(_event: 'message', listener: (channel: string, message: string) => void) {
          localListeners.add(listener);
          emitterListeners.add(listener);
        },
        off(_event: 'message', listener: (channel: string, message: string) => void) {
          localListeners.delete(listener);
          emitterListeners.delete(listener);
        },
        async subscribe(channel: string) {
          let set = redisChannels.get(channel);
          if (!set) {
            set = new Set();
            redisChannels.set(channel, set);
          }
          for (const l of localListeners) {
            set.add(l);
          }
        },
        async unsubscribe(channel: string) {
          const set = redisChannels.get(channel);
          if (set) {
            for (const l of localListeners) {
              set.delete(l);
            }
          }
        },
      };
    };

    const redisHub1 = createRealtimeHub({
      nodeId: 'redis-node-1',
      pubSub: createRedisRealtimePubSubAdapter({
        publisher: mockRedisPublisher,
        subscriber: createMockRedisSubscriber(),
      }),
    });
    const redisHub2 = createRealtimeHub({
      nodeId: 'redis-node-2',
      pubSub: createRedisRealtimePubSubAdapter({
        publisher: mockRedisPublisher,
        subscriber: createMockRedisSubscriber(),
      }),
    });

    const rClient1 = createMockWsConnection({ id: 'r1' });
    const rClient2 = createMockWsConnection({ id: 'r2' });
    await redisHub1.join('orders', rClient1.conn);
    await redisHub2.join('orders', rClient2.conn);

    await redisHub1.broadcast('orders', { orderId: 'ord_99', status: 'paid' });
    expect(rClient1.sent).toHaveLength(1);
    expect(rClient2.sent).toHaveLength(1);
    expect(JSON.parse(String(rClient2.sent[0]))).toEqual({ orderId: 'ord_99', status: 'paid' });

    await redisHub1.closeAll();
    await redisHub2.closeAll();
    await hubA.closeAll();
    await hubB.closeAll();
  });

  it('enforces bounded backpressure limits across disconnect, drop-newest, drop-oldest, and error strategies', async () => {
    // 1. 'disconnect' strategy (default) evicts slow consumers with 1008 Policy Violation
    let simulatedBuffer = 600;
    const slowClient = createMockWsConnection({
      id: 'slow-1',
      bufferedAmount: () => simulatedBuffer,
    });
    const healthyClient = createMockWsConnection({
      id: 'healthy-1',
      bufferedAmount: () => 0,
    });

    const disconnectHub = createRealtimeHub({
      maxBufferedBytes: 512,
      backpressureStrategy: 'disconnect',
    });
    await disconnectHub.join('stream', slowClient.conn);
    await disconnectHub.join('stream', healthyClient.conn);

    const res1 = await disconnectHub.broadcast('stream', 'hello-world');
    expect(res1.deliveredWebSockets).toBe(1);
    expect(res1.disconnectedBackpressure).toBe(1);
    expect(slowClient.closeCalls).toEqual([{ code: 1008, reason: 'Backpressure limit exceeded' }]);
    expect(disconnectHub.isMember('stream', 'slow-1')).toBe(false);
    expect(healthyClient.sent).toEqual(['hello-world']);

    // 2. 'drop-newest' strategy keeps socket open but drops frames exceeding maxBufferedBytes
    const dropNewestClient = createMockWsConnection({
      id: 'slow-drop-newest',
      bufferedAmount: () => simulatedBuffer,
    });
    const dropNewestHub = createRealtimeHub({
      maxBufferedBytes: 512,
      backpressureStrategy: 'drop-newest',
    });
    await dropNewestHub.join('ticks', dropNewestClient.conn);

    const res2 = await dropNewestHub.broadcast('ticks', 'tick-1');
    expect(res2.deliveredWebSockets).toBe(0);
    expect(res2.droppedBackpressure).toBe(1);
    expect(dropNewestClient.closeCalls).toHaveLength(0);

    // Once buffer drains, subsequent broadcasts succeed
    simulatedBuffer = 0;
    const res3 = await dropNewestHub.broadcast('ticks', 'tick-2');
    expect(res3.deliveredWebSockets).toBe(1);
    expect(dropNewestClient.sent).toEqual(['tick-2']);

    // 3. 'drop-oldest' strategy maintains bounded pending queue and evicts oldest messages
    const dropOldestClient = createMockWsConnection({ id: 'slow-drop-oldest' });
    const dropOldestHub = createRealtimeHub({
      maxBufferedBytes: 1024,
      maxPendingMessages: 2,
      backpressureStrategy: 'drop-oldest',
    });
    await dropOldestHub.join('feed', dropOldestClient.conn);

    await dropOldestHub.broadcast('feed', 'msg-1');
    await dropOldestHub.broadcast('feed', 'msg-2');
    await dropOldestHub.broadcast('feed', 'msg-3'); // evicts msg-1 from pending queue
    expect(dropOldestHub.getQueuedMessages('slow-drop-oldest')).toEqual(['msg-2', 'msg-3']);

    dropOldestHub.acknowledgeBufferedBytes('slow-drop-oldest', 5);
    expect(dropOldestHub.getQueuedMessages('slow-drop-oldest')).toEqual(['msg-3']);

    // 4. 'error' strategy throws RealtimeBackpressureError
    const errorClient = createMockWsConnection({
      id: 'slow-error',
      bufferedAmount: () => 1000,
    });
    const errorHub = createRealtimeHub({
      maxBufferedBytes: 256,
      backpressureStrategy: 'error',
    });
    await errorHub.join('strict', errorClient.conn);
    expect(() => errorHub.sendTo('slow-error', 'overflow')).toThrow(RealtimeBackpressureError);
  });

  it('manages WebSocket heartbeat pings, pong timeouts, idle timeouts, and automatic hub cleanup deterministically', async () => {
    let now = 1_000;
    const hub = createRealtimeHub({ clock: () => now });
    const heartbeat = createWebSocketHeartbeat({
      heartbeatIntervalMs: 1_000,
      pongTimeoutMs: 500,
      idleTimeoutMs: 5_000,
      hub,
      autoStartTimer: false,
      clock: () => now,
    });

    const activeWs = createMockWsConnection({ id: 'ws-active' });
    const zombieWs = createMockWsConnection({ id: 'ws-zombie' });

    const wrapped = heartbeat.wrapHandlers({
      async onOpen(ws) {
        await hub.join('monitoring', ws);
      },
    });

    const dummyCtx = createWebSocketUpgradeContext({
      request: new Request('http://localhost/ws'),
      url: new URL('http://localhost/ws'),
      path: '/ws',
      headers: new Headers(),
      params: {},
      query: {},
      runtime: 'memory',
      protocol: '',
    });

    await wrapped.onOpen?.(activeWs.conn, dummyCtx);
    await wrapped.onOpen?.(zombieWs.conn, dummyCtx);
    expect(heartbeat.trackedCount()).toBe(2);
    expect(hub.roomSize('monitoring')).toBe(2);

    // Advance 1,000ms -> tick() sends ping to both connections
    now = 2_000;
    expect(heartbeat.tick()).toBe(0);
    expect(activeWs.pings).toHaveLength(1);
    expect(zombieWs.pings).toHaveLength(1);

    // Active client responds with onPong; zombie client stays silent
    now = 2_200;
    await wrapped.onPong?.(activeWs.conn, new Uint8Array(0));

    // Advance past pongTimeoutMs (2_000 + 500 = 2_500) -> zombie client is evicted with 1001!
    now = 2_600;
    expect(heartbeat.tick()).toBe(1);
    expect(zombieWs.closeCalls).toEqual([{ code: 1001, reason: 'Heartbeat timeout' }]);
    expect(hub.isMember('monitoring', 'ws-zombie')).toBe(false);
    expect(hub.isMember('monitoring', 'ws-active')).toBe(true);

    // Keep responding to pings on activeWs, or test idle timeout when no activity occurs for 5_000ms
    now = 8_000;
    expect(heartbeat.tick()).toBe(1);
    expect(activeWs.closeCalls).toEqual([{ code: 1000, reason: 'Idle timeout' }]);
    expect(hub.roomSize('monitoring')).toBe(0);
  });

  it('supports SSE Last-Event-ID extraction, replay ring buffer, keepalive comments, room subscriptions, and EventDispatcher bridging', async () => {
    let now = 10_000;
    const buffer = createSseEventBuffer<{ readonly price: number }>({
      maxEvents: 3,
      ttlMs: 60_000,
      idPrefix: 'tick_',
      clock: () => now,
    });

    const e1 = buffer.append({ event: 'price', data: { price: 101 } });
    const e2 = buffer.append({ event: 'price', data: { price: 102 } });
    const e3 = buffer.append({ event: 'price', data: { price: 103 } });
    expect(e1.id).toBe('tick_1');
    expect(e2.id).toBe('tick_2');
    expect(e3.id).toBe('tick_3');
    expect(buffer.replaySince('tick_1').map((e) => e.data.price)).toEqual([102, 103]);

    // TestRealtimeHub + EventDispatcher bridge + SSE Last-Event-ID replay over HTTP
    interface AppEvents extends Record<string, unknown> {
      'order.updated': { readonly orderId: string; readonly status: string };
    }
    const events = createEventDispatcher<AppEvents>();
    const hub = createRealtimeHub({ clock: () => now });
    const bridge = createEventDispatcherRealtimeBridge({
      hub,
      events,
      topics: {
        'order.updated': (payload) => ({
          room: `orders:${payload.orderId}`,
          event: 'order.updated',
          data: payload,
        }),
      },
    });

    // Emit two domain events BEFORE the SSE client reconnects with Last-Event-ID
    await events.emit('order.updated', { orderId: '42', status: 'confirmed' });
    await events.emit('order.updated', { orderId: '42', status: 'shipped' });

    const app = createHttpApp();
    app.get('/events/orders/:orderId', (ctx) => {
      const orderId = ctx.params['orderId'] ?? '42';
      return hub.subscribeSse(ctx, {
        rooms: `orders:${orderId}`,
        retryMs: 2000,
        async onSubscribed(stream) {
          // Emit one live event after subscription and then close the stream for deterministic test completion
          await events.emit('order.updated', { orderId, status: 'delivered' });
          stream.close();
        },
      });
    });

    const client = createTestClient(app);

    // Reconnect presenting Last-Event-ID: orders:42_1 -> should replay orders:42_2 ('shipped') and receive live orders:42_3 ('delivered')
    const sseRes = await client.sse('/events/orders/42', {
      headers: { 'last-event-id': 'orders:42_1' },
    });
    expect(sseRes.status).toBe(200);

    const receivedEvents = sseRes.events;
    expect(receivedEvents.length).toBeGreaterThanOrEqual(2);
    const statuses = receivedEvents
      .filter((e) => e.data.length > 0)
      .map((e) => (JSON.parse(e.data) as { status: string }).status);
    expect(statuses).toEqual(['shipped', 'delivered']);

    // Verify extractLastEventId rejects CR/LF injection via query param or custom Headers getter
    const maliciousQueryReq = new Request('http://localhost/events?lastEventId=123%0D%0Adata%3Ainjected');
    expect(extractLastEventId(maliciousQueryReq)).toBeUndefined();
    const maliciousHeaderLike = {
      get(name: string) {
        return name.toLowerCase() === 'last-event-id' ? '123\r\ndata: injected' : null;
      },
    } as unknown as Headers;
    expect(extractLastEventId(maliciousHeaderLike)).toBeUndefined();

    // Verify withRealtimeWebSocket helper export
    const wrappedHandlers = withRealtimeWebSocket(
      {
        onOpen() {},
      },
      { hub, autoStartTimer: false },
    );
    expect(typeof wrappedHandlers.onOpen).toBe('function');

    bridge.dispose();
    await hub.closeAll();
    await client.close();
  });
});
