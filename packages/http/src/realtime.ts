import type { EventDispatcher } from '@forge-fr/core';
import { ForgeHttpError } from './errors.js';
import {
  createSseEventBuffer,
  createSseResponse,
  extractLastEventId,
  formatSseEvent,
  type BufferedSseEvent,
  type CreateSseResponseOptions,
  type ExtractLastEventIdSource,
  type SseEventBuffer,
  type SseEventBufferOptions,
} from './sse.js';
import type {
  ForgeContext,
  SseEvent,
  SseStreamController,
  WebSocketCloseInfo,
  WebSocketConnection,
  WebSocketHandlers,
  WebSocketMessageData,
  WebSocketUpgradeContext,
} from './types.js';
import {
  DEFAULT_WS_MAX_PAYLOAD_BYTES,
  WebSocketRouteRegistry,
  createWebSocketConnection,
  createWebSocketUpgradeContext,
  type CreateWebSocketConnectionTransport,
  type CreateWebSocketUpgradeContextInit,
} from './websocket.js';

export {
  DEFAULT_WS_MAX_PAYLOAD_BYTES,
  WebSocketRouteRegistry,
  createSseEventBuffer,
  createSseResponse,
  createWebSocketConnection,
  createWebSocketUpgradeContext,
  extractLastEventId,
  formatSseEvent,
  type BufferedSseEvent,
  type CreateSseResponseOptions,
  type CreateWebSocketConnectionTransport,
  type CreateWebSocketUpgradeContextInit,
  type ExtractLastEventIdSource,
  type SseEventBuffer,
  type SseEventBufferOptions,
};

const utf8Encoder = new TextEncoder();

export const DEFAULT_REALTIME_MAX_BUFFERED_BYTES = 524_288; // 512 KiB
export const DEFAULT_REALTIME_MAX_PENDING_MESSAGES = 128;
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;
export const DEFAULT_PONG_TIMEOUT_MS = 10_000;

export type BackpressureStrategy = 'disconnect' | 'drop-newest' | 'drop-oldest' | 'error';

export class RealtimeBackpressureError extends ForgeHttpError {
  public readonly connectionId: string;
  public readonly bufferedBytes: number;
  public readonly maxBufferedBytes: number;

  public constructor(
    connectionId: string,
    bufferedBytes: number,
    maxBufferedBytes: number,
    message = `Realtime connection "${connectionId}" exceeded backpressure limit (${bufferedBytes} > ${maxBufferedBytes} bytes)`,
  ) {
    super(message, {
      code: 'REALTIME_BACKPRESSURE_EXCEEDED',
      statusCode: 429,
      expose: false,
      details: { connectionId, bufferedBytes, maxBufferedBytes },
    });
    this.connectionId = connectionId;
    this.bufferedBytes = bufferedBytes;
    this.maxBufferedBytes = maxBufferedBytes;
  }
}

export interface RealtimePubSubEnvelope {
  readonly originNodeId: string;
  readonly room: string;
  readonly payload: string;
  readonly isBinaryBase64?: boolean;
  readonly event?: string;
  readonly id?: string;
  readonly excludeIds?: readonly string[];
  readonly timestamp: number;
}

export type RealtimePubSubListener = (envelope: RealtimePubSubEnvelope) => void | Promise<void>;

export interface RealtimePubSubAdapter {
  readonly name: string;
  publish(channel: string, envelope: RealtimePubSubEnvelope): Promise<void> | void;
  subscribe(
    channel: string,
    listener: RealtimePubSubListener,
  ): Promise<() => Promise<void> | void> | (() => Promise<void> | void);
  close?(): Promise<void> | void;
}

export interface MemoryRealtimePubSubBus {
  createAdapter(name?: string): RealtimePubSubAdapter;
}

/**
 * Creates a shareable in-memory pub/sub bus that can link multiple `RealtimeHub`
 * instances in tests or single-process multi-worker setups.
 */
export function createMemoryRealtimePubSubBus(): MemoryRealtimePubSubBus {
  const subscribers = new Map<string, Set<RealtimePubSubListener>>();

  return {
    createAdapter(name = 'memory'): RealtimePubSubAdapter {
      const localRegs: Array<{ channel: string; listener: RealtimePubSubListener }> = [];
      return {
        name,
        publish(channel: string, envelope: RealtimePubSubEnvelope): void {
          const set = subscribers.get(channel);
          if (!set) return;
          for (const listener of Array.from(set)) {
            void Promise.resolve(listener(envelope)).catch(() => {});
          }
        },
        subscribe(channel: string, listener: RealtimePubSubListener): () => void {
          let set = subscribers.get(channel);
          if (!set) {
            set = new Set<RealtimePubSubListener>();
            subscribers.set(channel, set);
          }
          set.add(listener);
          localRegs.push({ channel, listener });
          return () => {
            set?.delete(listener);
            if (set && set.size === 0) {
              subscribers.delete(channel);
            }
          };
        },
        close(): void {
          for (const reg of localRegs) {
            const set = subscribers.get(reg.channel);
            set?.delete(reg.listener);
            if (set && set.size === 0) {
              subscribers.delete(reg.channel);
            }
          }
          localRegs.length = 0;
        },
      };
    },
  };
}

export function createMemoryRealtimePubSubAdapter(): RealtimePubSubAdapter {
  return createMemoryRealtimePubSubBus().createAdapter('memory');
}

export interface RedisPubSubPublisherLike {
  publish(channel: string, message: string): Promise<unknown> | unknown;
}

export interface RedisPubSubSubscriberLike {
  subscribe(
    channel: string,
    listener?: (message: string, channel?: string) => void,
  ): Promise<unknown> | unknown;
  unsubscribe?(
    channel: string,
    listener?: (message: string, channel?: string) => void,
  ): Promise<unknown> | unknown;
  on?(event: 'message', listener: (channel: string, message: string) => void): unknown;
  off?(event: 'message', listener: (channel: string, message: string) => void): unknown;
}

export interface RedisRealtimePubSubOptions {
  readonly publisher: RedisPubSubPublisherLike;
  readonly subscriber: RedisPubSubSubscriberLike;
  /** Channel prefix applied to all Redis pub/sub channels (default: `'forge:rt:'`). */
  readonly channelPrefix?: string;
}

/**
 * Structural Redis Pub/Sub adapter for multi-node `RealtimeHub` fan-out.
 * Requires zero hard runtime dependencies and works with `redis` (node-redis), `ioredis`, or Upstash-compatible clients.
 */
export function createRedisRealtimePubSubAdapter(
  options: RedisRealtimePubSubOptions,
): RealtimePubSubAdapter {
  const prefix = options.channelPrefix ?? 'forge:rt:';
  const channelListeners = new Map<string, Set<RealtimePubSubListener>>();
  let eventEmitterAttached = false;

  const dispatchRawMessage = (fullChannel: string, rawMessage: string): void => {
    const set = channelListeners.get(fullChannel);
    if (!set || set.size === 0) return;
    let parsed: RealtimePubSubEnvelope;
    try {
      parsed = JSON.parse(rawMessage) as RealtimePubSubEnvelope;
    } catch {
      return;
    }
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      typeof parsed.originNodeId !== 'string' ||
      typeof parsed.room !== 'string' ||
      typeof parsed.payload !== 'string'
    ) {
      return;
    }
    for (const listener of Array.from(set)) {
      void Promise.resolve(listener(parsed)).catch(() => {});
    }
  };

  const onEmitterMessage = (fullChannel: string, rawMessage: string): void => {
    dispatchRawMessage(fullChannel, rawMessage);
  };

  return {
    name: 'redis',

    async publish(channel: string, envelope: RealtimePubSubEnvelope): Promise<void> {
      const fullChannel = `${prefix}${channel}`;
      await options.publisher.publish(fullChannel, JSON.stringify(envelope));
    },

    async subscribe(
      channel: string,
      listener: RealtimePubSubListener,
    ): Promise<() => Promise<void>> {
      const fullChannel = `${prefix}${channel}`;
      let set = channelListeners.get(fullChannel);
      const isFirst = !set || set.size === 0;
      if (!set) {
        set = new Set<RealtimePubSubListener>();
        channelListeners.set(fullChannel, set);
      }
      set.add(listener);

      const callbackAdapter = (rawMessage: string): void => {
        dispatchRawMessage(fullChannel, rawMessage);
      };

      if (isFirst) {
        if (typeof options.subscriber.on === 'function') {
          if (!eventEmitterAttached) {
            options.subscriber.on('message', onEmitterMessage);
            eventEmitterAttached = true;
          }
          await options.subscriber.subscribe(fullChannel);
        } else {
          await options.subscriber.subscribe(fullChannel, callbackAdapter);
        }
      }

      return async (): Promise<void> => {
        const currentSet = channelListeners.get(fullChannel);
        if (!currentSet) return;
        currentSet.delete(listener);
        if (currentSet.size === 0) {
          channelListeners.delete(fullChannel);
          if (typeof options.subscriber.unsubscribe === 'function') {
            await options.subscriber.unsubscribe(fullChannel);
          }
        }
      };
    },

    async close(): Promise<void> {
      if (eventEmitterAttached && typeof options.subscriber.off === 'function') {
        options.subscriber.off('message', onEmitterMessage);
        eventEmitterAttached = false;
      }
      if (typeof options.subscriber.unsubscribe === 'function') {
        for (const fullChannel of Array.from(channelListeners.keys())) {
          await options.subscriber.unsubscribe(fullChannel);
        }
      }
      channelListeners.clear();
    },
  };
}

export interface RealtimePresenceEntry<TMetadata extends Record<string, unknown> = Record<string, unknown>> {
  readonly connectionId: string;
  readonly room: string;
  readonly transport: 'websocket' | 'sse';
  readonly joinedAt: number;
  readonly updatedAt: number;
  readonly metadata: Readonly<TMetadata>;
}

export interface RealtimeBroadcastOptions {
  /** Connection ID or array of connection IDs to exclude from receiving the broadcast. */
  readonly exclude?: string | readonly string[];
  /** Optional logical event name (used for SSE `event:` field and JSON envelope if enabled). */
  readonly event?: string;
  /** Optional explicit event ID (used for SSE `id:` replay buffer and deduplication). */
  readonly id?: string;
  /** When `true`, skips publishing to the cross-node `pubSub` adapter. */
  readonly localOnly?: boolean;
}

export interface RealtimeBroadcastResult {
  readonly room: string;
  readonly eventId: string;
  readonly deliveredWebSockets: number;
  readonly deliveredSse: number;
  readonly droppedBackpressure: number;
  readonly disconnectedBackpressure: number;
}

export interface RealtimeSendOptions {
  readonly event?: string;
  readonly id?: string;
}

export interface RealtimeSendResult {
  readonly delivered: boolean;
  readonly dropped: boolean;
  readonly disconnected: boolean;
}

export interface SseHubSubscriptionOptions extends CreateSseResponseOptions {
  /** Room name or list of room names to subscribe this SSE stream to. */
  readonly rooms: string | readonly string[];
  /** Optional connection ID override (defaults to `ctx.requestId` or random UUID). */
  readonly connectionId?: string;
  /** Optional presence metadata attached to each joined room. */
  readonly metadata?: Record<string, unknown>;
  /** When `true` (default), replays any buffered room events since `Last-Event-ID`. */
  readonly replayMissedEvents?: boolean;
  /** Optional callback invoked after room join and missed-event replay completes. */
  readonly onSubscribed?: (stream: SseStreamController, connectionId: string) => Promise<void> | void;
}

export interface RealtimeHubOptions {
  /** Unique node identifier for multi-node pub/sub deduplication (default: random UUID). */
  readonly nodeId?: string;
  /** Optional cross-node pub/sub broker adapter (e.g. Redis or shared memory bus). */
  readonly pubSub?: RealtimePubSubAdapter;
  /** Maximum buffered outbound bytes per connection before applying `backpressureStrategy` (default: 512 KiB). */
  readonly maxBufferedBytes?: number;
  /** Maximum pending queued messages per connection before applying `backpressureStrategy` (default: 128). */
  readonly maxPendingMessages?: number;
  /** Action taken when a slow consumer exceeds backpressure limits (default: `'disconnect'`). */
  readonly backpressureStrategy?: BackpressureStrategy;
  /** Optional custom extractor for a connection's current transport buffer size in bytes. */
  readonly getBufferedBytes?: (conn: WebSocketConnection) => number;
  /** Maximum number of events retained per room for SSE `Last-Event-ID` replay (default: 256). */
  readonly replayBufferSize?: number;
  /** Maximum age in ms for SSE `Last-Event-ID` replay events (default: 300_000 = 5 min). */
  readonly replayBufferTtlMs?: number;
  /** Optional injectable clock (default: `Date.now`). */
  readonly clock?: () => number;
}

export interface RealtimeHub {
  readonly nodeId: string;
  join(
    room: string,
    connection: WebSocketConnection,
    metadata?: Record<string, unknown>,
  ): Promise<void>;
  leave(room: string, connectionOrId: WebSocketConnection | string): Promise<void>;
  leaveAll(connectionOrId: WebSocketConnection | string): Promise<void>;
  broadcast(
    room: string,
    payload: WebSocketMessageData | Record<string, unknown> | readonly unknown[],
    options?: RealtimeBroadcastOptions,
  ): Promise<RealtimeBroadcastResult>;
  broadcastAll(
    payload: WebSocketMessageData | Record<string, unknown> | readonly unknown[],
    options?: RealtimeBroadcastOptions,
  ): Promise<RealtimeBroadcastResult>;
  sendTo(
    connectionOrId: WebSocketConnection | string,
    payload: WebSocketMessageData | Record<string, unknown> | readonly unknown[],
    options?: RealtimeSendOptions,
  ): RealtimeSendResult;
  /** Credits/acknowledges drained outbound bytes for a connection when manual backpressure accounting is used. */
  acknowledgeBufferedBytes(connectionOrId: WebSocketConnection | string, bytes: number): void;
  /** Returns current tracked buffered bytes for a connection. */
  getTrackedBufferedBytes(connectionOrId: WebSocketConnection | string): number;
  /** Returns current queued messages count for a connection (when `'drop-oldest'` / queue buffering is active). */
  getQueuedMessages(connectionOrId: WebSocketConnection | string): readonly WebSocketMessageData[];
  rooms(): readonly string[];
  members(room: string): readonly string[];
  roomSize(room: string): number;
  isMember(room: string, connectionOrId: WebSocketConnection | string): boolean;
  getPresence<TMetadata extends Record<string, unknown> = Record<string, unknown>>(
    room: string,
  ): readonly RealtimePresenceEntry<TMetadata>[];
  updatePresence(
    room: string,
    connectionOrId: WebSocketConnection | string,
    metadata: Record<string, unknown>,
  ): boolean;
  connections(): readonly WebSocketConnection[];
  connectionCount(): number;
  getRoomReplayBuffer(room: string): SseEventBuffer<unknown>;
  subscribeSse(ctx: ForgeContext, options: SseHubSubscriptionOptions): Response;
  closeAll(code?: number, reason?: string): Promise<void>;
}

interface InternalSubscriber {
  readonly id: string;
  readonly transport: 'websocket' | 'sse';
  readonly ws?: WebSocketConnection;
  readonly sse?: SseStreamController;
  trackedBufferedBytes: number;
  readonly pendingQueue: Array<{ data: WebSocketMessageData; byteLength: number }>;
  readonly rooms: Set<string>;
}

function measurePayloadBytes(data: WebSocketMessageData): number {
  return typeof data === 'string' ? utf8Encoder.encode(data).byteLength : data.byteLength;
}

function normalizeOutboundPayload(
  payload: WebSocketMessageData | Record<string, unknown> | readonly unknown[],
): { readonly wsData: WebSocketMessageData; readonly stringData: string; readonly isBinary: boolean } {
  if (typeof payload === 'string') {
    return { wsData: payload, stringData: payload, isBinary: false };
  }
  if (payload instanceof Uint8Array) {
    let binary = '';
    for (let i = 0; i < payload.byteLength; i += 1) {
      binary += String.fromCharCode(payload[i]!);
    }
    return { wsData: payload, stringData: globalThis.btoa(binary), isBinary: true };
  }
  const serialized = JSON.stringify(payload);
  return { wsData: serialized, stringData: serialized, isBinary: false };
}

function decodeBase64ToBytes(b64: string): Uint8Array {
  const binary = globalThis.atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

function resolveConnectionId(connectionOrId: WebSocketConnection | string): string {
  return typeof connectionOrId === 'string' ? connectionOrId : connectionOrId.id;
}

export function createRealtimeHub(options: RealtimeHubOptions = {}): RealtimeHub {
  const nodeId = options.nodeId ?? globalThis.crypto.randomUUID();
  const maxBufferedBytes = Math.max(1, options.maxBufferedBytes ?? DEFAULT_REALTIME_MAX_BUFFERED_BYTES);
  const maxPendingMessages = Math.max(
    1,
    options.maxPendingMessages ?? DEFAULT_REALTIME_MAX_PENDING_MESSAGES,
  );
  const backpressureStrategy: BackpressureStrategy = options.backpressureStrategy ?? 'disconnect';
  const replayBufferSize = options.replayBufferSize ?? 256;
  const replayBufferTtlMs = options.replayBufferTtlMs ?? 300_000;
  const clock = options.clock ?? (() => Date.now());

  const subscribersById = new Map<string, InternalSubscriber>();
  const roomMembers = new Map<string, Map<string, RealtimePresenceEntry>>();
  const roomReplayBuffers = new Map<string, SseEventBuffer<unknown>>();
  const pubSubUnsubs = new Map<string, () => Promise<void> | void>();
  let eventSeq = 0;

  function ensureRoomReplayBuffer(room: string): SseEventBuffer<unknown> {
    let buf = roomReplayBuffers.get(room);
    if (!buf) {
      buf = createSseEventBuffer<unknown>({
        maxEvents: replayBufferSize,
        ttlMs: replayBufferTtlMs,
        idPrefix: `${room}_`,
        clock,
      });
      roomReplayBuffers.set(room, buf);
    }
    return buf;
  }

  function ensureSubscriberForWs(conn: WebSocketConnection): InternalSubscriber {
    let sub = subscribersById.get(conn.id);
    if (!sub) {
      sub = {
        id: conn.id,
        transport: 'websocket',
        ws: conn,
        trackedBufferedBytes: 0,
        pendingQueue: [],
        rooms: new Set<string>(),
      };
      subscribersById.set(conn.id, sub);
    }
    return sub;
  }

  async function ensurePubSubRoomSubscription(room: string): Promise<void> {
    if (!options.pubSub || pubSubUnsubs.has(room)) {
      return;
    }
    const unsub = await options.pubSub.subscribe(`room:${room}`, (envelope) => {
      if (envelope.originNodeId === nodeId) {
        return;
      }
      const wsPayload: WebSocketMessageData = envelope.isBinaryBase64
        ? decodeBase64ToBytes(envelope.payload)
        : envelope.payload;
      deliverRoomLocal(envelope.room, wsPayload, envelope.payload, {
        ...(envelope.event !== undefined ? { event: envelope.event } : {}),
        ...(envelope.id !== undefined ? { id: envelope.id } : {}),
        ...(envelope.excludeIds !== undefined ? { exclude: envelope.excludeIds } : {}),
        localOnly: true,
      });
    });
    pubSubUnsubs.set(room, unsub);
  }

  async function cleanupEmptyRoom(room: string): Promise<void> {
    const members = roomMembers.get(room);
    if (members && members.size === 0) {
      roomMembers.delete(room);
      const unsub = pubSubUnsubs.get(room);
      if (unsub) {
        pubSubUnsubs.delete(room);
        await unsub();
      }
    }
  }

  function removeSubscriberFromAllRoomsSync(sub: InternalSubscriber): string[] {
    const emptiedRooms: string[] = [];
    for (const room of Array.from(sub.rooms)) {
      sub.rooms.delete(room);
      const members = roomMembers.get(room);
      if (members) {
        members.delete(sub.id);
        if (members.size === 0) {
          emptiedRooms.push(room);
        }
      }
    }
    subscribersById.delete(sub.id);
    return emptiedRooms;
  }

  function getEffectiveBufferedBytes(sub: InternalSubscriber): number {
    if (sub.ws) {
      const transportBuffered = options.getBufferedBytes
        ? options.getBufferedBytes(sub.ws)
        : (sub.ws.bufferedAmount ?? 0);
      return Math.max(transportBuffered, sub.trackedBufferedBytes);
    }
    return sub.trackedBufferedBytes;
  }

  function deliverToSubscriber(
    sub: InternalSubscriber,
    wsData: WebSocketMessageData,
    sseStringData: string,
    sendOpts?: { readonly event?: string; readonly id?: string },
  ): RealtimeSendResult {
    if (sub.transport === 'sse') {
      if (!sub.sse || sub.sse.closed) {
        const emptied = removeSubscriberFromAllRoomsSync(sub);
        for (const r of emptied) {
          void cleanupEmptyRoom(r);
        }
        return { delivered: false, dropped: false, disconnected: true };
      }
      sub.sse.send({
        data: sseStringData,
        ...(sendOpts?.event !== undefined ? { event: sendOpts.event } : {}),
        ...(sendOpts?.id !== undefined ? { id: sendOpts.id } : {}),
      });
      return { delivered: true, dropped: false, disconnected: false };
    }

    const ws = sub.ws;
    if (!ws || ws.readyState !== 'open') {
      const emptied = removeSubscriberFromAllRoomsSync(sub);
      for (const r of emptied) {
        void cleanupEmptyRoom(r);
      }
      return { delivered: false, dropped: false, disconnected: true };
    }

    const incomingBytes = measurePayloadBytes(wsData);
    const currentBuffered = getEffectiveBufferedBytes(sub);
    const exceedsBytes = currentBuffered + incomingBytes > maxBufferedBytes;
    const exceedsCount = sub.pendingQueue.length >= maxPendingMessages;

    if (exceedsBytes || exceedsCount) {
      if (backpressureStrategy === 'drop-newest') {
        return { delivered: false, dropped: true, disconnected: false };
      }

      if (backpressureStrategy === 'drop-oldest') {
        while (
          sub.pendingQueue.length > 0 &&
          (getEffectiveBufferedBytes(sub) + incomingBytes > maxBufferedBytes ||
            sub.pendingQueue.length >= maxPendingMessages)
        ) {
          const evicted = sub.pendingQueue.shift();
          if (evicted) {
            sub.trackedBufferedBytes = Math.max(0, sub.trackedBufferedBytes - evicted.byteLength);
          }
        }
        if (getEffectiveBufferedBytes(sub) + incomingBytes > maxBufferedBytes) {
          return { delivered: false, dropped: true, disconnected: false };
        }
        sub.pendingQueue.push({ data: wsData, byteLength: incomingBytes });
        sub.trackedBufferedBytes += incomingBytes;
        ws.send(wsData);
        return { delivered: true, dropped: true, disconnected: false };
      }

      if (backpressureStrategy === 'error') {
        throw new RealtimeBackpressureError(
          sub.id,
          currentBuffered + incomingBytes,
          maxBufferedBytes,
        );
      }

      // Default: 'disconnect' slow consumer with 1008 Policy Violation
      const emptied = removeSubscriberFromAllRoomsSync(sub);
      for (const r of emptied) {
        void cleanupEmptyRoom(r);
      }
      ws.close(1008, 'Backpressure limit exceeded');
      return { delivered: false, dropped: false, disconnected: true };
    }

    if (backpressureStrategy === 'drop-oldest') {
      sub.pendingQueue.push({ data: wsData, byteLength: incomingBytes });
      sub.trackedBufferedBytes += incomingBytes;
    }
    ws.send(wsData);
    return { delivered: true, dropped: false, disconnected: false };
  }

  function deliverRoomLocal(
    room: string,
    wsData: WebSocketMessageData,
    stringData: string,
    bcastOpts?: RealtimeBroadcastOptions,
  ): RealtimeBroadcastResult {
    eventSeq += 1;
    const eventId = bcastOpts?.id ?? `${room}_${eventSeq}`;
    const replayBuf = ensureRoomReplayBuffer(room);
    replayBuf.append({
      id: eventId,
      data: stringData,
      ...(bcastOpts?.event !== undefined ? { event: bcastOpts.event } : {}),
    });

    const excludeSet =
      bcastOpts?.exclude === undefined
        ? null
        : new Set(typeof bcastOpts.exclude === 'string' ? [bcastOpts.exclude] : bcastOpts.exclude);

    const members = roomMembers.get(room);
    if (!members || members.size === 0) {
      return {
        room,
        eventId,
        deliveredWebSockets: 0,
        deliveredSse: 0,
        droppedBackpressure: 0,
        disconnectedBackpressure: 0,
      };
    }

    let deliveredWebSockets = 0;
    let deliveredSse = 0;
    let droppedBackpressure = 0;
    let disconnectedBackpressure = 0;

    for (const memberId of Array.from(members.keys())) {
      if (excludeSet && excludeSet.has(memberId)) {
        continue;
      }
      const sub = subscribersById.get(memberId);
      if (!sub) {
        members.delete(memberId);
        continue;
      }
      const res = deliverToSubscriber(sub, wsData, stringData, {
        id: eventId,
        ...(bcastOpts?.event !== undefined ? { event: bcastOpts.event } : {}),
      });
      if (res.delivered) {
        if (sub.transport === 'sse') {
          deliveredSse += 1;
        } else {
          deliveredWebSockets += 1;
        }
      }
      if (res.dropped) {
        droppedBackpressure += 1;
      }
      if (res.disconnected) {
        disconnectedBackpressure += 1;
      }
    }

    return {
      room,
      eventId,
      deliveredWebSockets,
      deliveredSse,
      droppedBackpressure,
      disconnectedBackpressure,
    };
  }

  return {
    nodeId,

    async join(
      room: string,
      connection: WebSocketConnection,
      metadata: Record<string, unknown> = {},
    ): Promise<void> {
      const sub = ensureSubscriberForWs(connection);
      sub.rooms.add(room);

      let members = roomMembers.get(room);
      if (!members) {
        members = new Map<string, RealtimePresenceEntry>();
        roomMembers.set(room, members);
      }

      const now = clock();
      const existing = members.get(connection.id);
      members.set(
        connection.id,
        Object.freeze({
          connectionId: connection.id,
          room,
          transport: 'websocket',
          joinedAt: existing?.joinedAt ?? now,
          updatedAt: now,
          metadata: Object.freeze({ ...(existing?.metadata ?? {}), ...metadata }),
        }),
      );

      await ensurePubSubRoomSubscription(room);
    },

    async leave(room: string, connectionOrId: WebSocketConnection | string): Promise<void> {
      const id = resolveConnectionId(connectionOrId);
      const sub = subscribersById.get(id);
      if (sub) {
        sub.rooms.delete(room);
        if (sub.rooms.size === 0) {
          subscribersById.delete(id);
        }
      }
      const members = roomMembers.get(room);
      if (members) {
        members.delete(id);
        await cleanupEmptyRoom(room);
      }
    },

    async leaveAll(connectionOrId: WebSocketConnection | string): Promise<void> {
      const id = resolveConnectionId(connectionOrId);
      const sub = subscribersById.get(id);
      if (!sub) return;
      const emptied = removeSubscriberFromAllRoomsSync(sub);
      for (const room of emptied) {
        await cleanupEmptyRoom(room);
      }
    },

    async broadcast(
      room: string,
      payload: WebSocketMessageData | Record<string, unknown> | readonly unknown[],
      bcastOpts?: RealtimeBroadcastOptions,
    ): Promise<RealtimeBroadcastResult> {
      const normalized = normalizeOutboundPayload(payload);
      const result = deliverRoomLocal(room, normalized.wsData, normalized.stringData, bcastOpts);

      if (options.pubSub && !bcastOpts?.localOnly) {
        const excludeIds =
          bcastOpts?.exclude === undefined
            ? undefined
            : typeof bcastOpts.exclude === 'string'
              ? [bcastOpts.exclude]
              : bcastOpts.exclude;
        await options.pubSub.publish(`room:${room}`, {
          originNodeId: nodeId,
          room,
          payload: normalized.stringData,
          ...(normalized.isBinary ? { isBinaryBase64: true } : {}),
          id: result.eventId,
          ...(bcastOpts?.event !== undefined ? { event: bcastOpts.event } : {}),
          ...(excludeIds !== undefined ? { excludeIds } : {}),
          timestamp: clock(),
        });
      }

      return result;
    },

    async broadcastAll(
      payload: WebSocketMessageData | Record<string, unknown> | readonly unknown[],
      bcastOpts?: RealtimeBroadcastOptions,
    ): Promise<RealtimeBroadcastResult> {
      const normalized = normalizeOutboundPayload(payload);
      eventSeq += 1;
      const eventId = bcastOpts?.id ?? `global_${eventSeq}`;
      const excludeSet =
        bcastOpts?.exclude === undefined
          ? null
          : new Set(
              typeof bcastOpts.exclude === 'string' ? [bcastOpts.exclude] : bcastOpts.exclude,
            );

      let deliveredWebSockets = 0;
      let deliveredSse = 0;
      let droppedBackpressure = 0;
      let disconnectedBackpressure = 0;

      for (const sub of Array.from(subscribersById.values())) {
        if (excludeSet && excludeSet.has(sub.id)) {
          continue;
        }
        const res = deliverToSubscriber(sub, normalized.wsData, normalized.stringData, {
          id: eventId,
          ...(bcastOpts?.event !== undefined ? { event: bcastOpts.event } : {}),
        });
        if (res.delivered) {
          if (sub.transport === 'sse') {
            deliveredSse += 1;
          } else {
            deliveredWebSockets += 1;
          }
        }
        if (res.dropped) {
          droppedBackpressure += 1;
        }
        if (res.disconnected) {
          disconnectedBackpressure += 1;
        }
      }

      return {
        room: '*',
        eventId,
        deliveredWebSockets,
        deliveredSse,
        droppedBackpressure,
        disconnectedBackpressure,
      };
    },

    sendTo(
      connectionOrId: WebSocketConnection | string,
      payload: WebSocketMessageData | Record<string, unknown> | readonly unknown[],
      sendOpts?: RealtimeSendOptions,
    ): RealtimeSendResult {
      const id = resolveConnectionId(connectionOrId);
      let sub = subscribersById.get(id);
      if (!sub && typeof connectionOrId !== 'string') {
        sub = ensureSubscriberForWs(connectionOrId);
      }
      if (!sub) {
        return { delivered: false, dropped: false, disconnected: false };
      }
      const normalized = normalizeOutboundPayload(payload);
      return deliverToSubscriber(sub, normalized.wsData, normalized.stringData, sendOpts);
    },

    acknowledgeBufferedBytes(connectionOrId: WebSocketConnection | string, bytes: number): void {
      const id = resolveConnectionId(connectionOrId);
      const sub = subscribersById.get(id);
      if (!sub || !Number.isFinite(bytes) || bytes <= 0) return;
      sub.trackedBufferedBytes = Math.max(0, sub.trackedBufferedBytes - bytes);
      let remaining = bytes;
      while (sub.pendingQueue.length > 0 && remaining > 0) {
        const head = sub.pendingQueue[0]!;
        if (head.byteLength <= remaining) {
          remaining -= head.byteLength;
          sub.pendingQueue.shift();
        } else {
          break;
        }
      }
    },

    getTrackedBufferedBytes(connectionOrId: WebSocketConnection | string): number {
      const id = resolveConnectionId(connectionOrId);
      const sub = subscribersById.get(id);
      return sub ? getEffectiveBufferedBytes(sub) : 0;
    },

    getQueuedMessages(connectionOrId: WebSocketConnection | string): readonly WebSocketMessageData[] {
      const id = resolveConnectionId(connectionOrId);
      const sub = subscribersById.get(id);
      return sub ? sub.pendingQueue.map((item) => item.data) : [];
    },

    rooms(): readonly string[] {
      return Array.from(roomMembers.keys()).filter((r) => (roomMembers.get(r)?.size ?? 0) > 0);
    },

    members(room: string): readonly string[] {
      const m = roomMembers.get(room);
      return m ? Array.from(m.keys()) : [];
    },

    roomSize(room: string): number {
      return roomMembers.get(room)?.size ?? 0;
    },

    isMember(room: string, connectionOrId: WebSocketConnection | string): boolean {
      const id = resolveConnectionId(connectionOrId);
      return roomMembers.get(room)?.has(id) ?? false;
    },

    getPresence<TMetadata extends Record<string, unknown> = Record<string, unknown>>(
      room: string,
    ): readonly RealtimePresenceEntry<TMetadata>[] {
      const m = roomMembers.get(room);
      if (!m) return [];
      return Array.from(m.values()) as RealtimePresenceEntry<TMetadata>[];
    },

    updatePresence(
      room: string,
      connectionOrId: WebSocketConnection | string,
      metadata: Record<string, unknown>,
    ): boolean {
      const id = resolveConnectionId(connectionOrId);
      const m = roomMembers.get(room);
      const existing = m?.get(id);
      if (!m || !existing) {
        return false;
      }
      m.set(
        id,
        Object.freeze({
          ...existing,
          updatedAt: clock(),
          metadata: Object.freeze({ ...existing.metadata, ...metadata }),
        }),
      );
      return true;
    },

    connections(): readonly WebSocketConnection[] {
      const list: WebSocketConnection[] = [];
      for (const sub of subscribersById.values()) {
        if (sub.ws && sub.ws.readyState === 'open') {
          list.push(sub.ws);
        }
      }
      return list;
    },

    connectionCount(): number {
      return subscribersById.size;
    },

    getRoomReplayBuffer(room: string): SseEventBuffer<unknown> {
      return ensureRoomReplayBuffer(room);
    },

    subscribeSse(ctx: ForgeContext, subOptions: SseHubSubscriptionOptions): Response {
      const roomList =
        typeof subOptions.rooms === 'string' ? [subOptions.rooms] : Array.from(subOptions.rooms);
      const connId = subOptions.connectionId ?? (ctx.requestId || globalThis.crypto.randomUUID());
      const resolvedLastId = subOptions.lastEventId ?? extractLastEventId(ctx);
      const replayMissed = subOptions.replayMissedEvents ?? true;

      return ctx.sse(
        async (stream) => {
          const sub: InternalSubscriber = {
            id: connId,
            transport: 'sse',
            sse: stream,
            trackedBufferedBytes: 0,
            pendingQueue: [],
            rooms: new Set<string>(roomList),
          };
          subscribersById.set(connId, sub);

          const now = clock();
          for (const room of roomList) {
            let members = roomMembers.get(room);
            if (!members) {
              members = new Map<string, RealtimePresenceEntry>();
              roomMembers.set(room, members);
            }
            members.set(
              connId,
              Object.freeze({
                connectionId: connId,
                room,
                transport: 'sse',
                joinedAt: now,
                updatedAt: now,
                metadata: Object.freeze({ ...(subOptions.metadata ?? {}) }),
              }),
            );
            await ensurePubSubRoomSubscription(room);

            if (replayMissed && resolvedLastId) {
              ensureRoomReplayBuffer(room).replayTo(stream, resolvedLastId);
            }
          }

          if (subOptions.onSubscribed) {
            await subOptions.onSubscribed(stream, connId);
          }

          if (!stream.closed && !ctx.signal.aborted) {
            await new Promise<void>((resolve) => {
              ctx.signal.addEventListener('abort', () => resolve(), { once: true });
            });
          }

          const emptied = removeSubscriberFromAllRoomsSync(sub);
          for (const r of emptied) {
            await cleanupEmptyRoom(r);
          }
        },
        {
          ...(subOptions.headers !== undefined ? { headers: subOptions.headers } : {}),
          ...(resolvedLastId !== undefined ? { lastEventId: resolvedLastId } : {}),
          ...(subOptions.keepAliveIntervalMs !== undefined
            ? { keepAliveIntervalMs: subOptions.keepAliveIntervalMs }
            : {}),
          ...(subOptions.keepAliveComment !== undefined
            ? { keepAliveComment: subOptions.keepAliveComment }
            : {}),
          ...(subOptions.retryMs !== undefined ? { retryMs: subOptions.retryMs } : {}),
        },
      );
    },

    async closeAll(code = 1001, reason = 'Server shutting down'): Promise<void> {
      for (const sub of Array.from(subscribersById.values())) {
        if (sub.ws && sub.ws.readyState === 'open') {
          sub.ws.close(code, reason);
        }
        if (sub.sse && !sub.sse.closed) {
          sub.sse.close();
        }
      }
      subscribersById.clear();
      roomMembers.clear();
      for (const unsub of Array.from(pubSubUnsubs.values())) {
        await unsub();
      }
      pubSubUnsubs.clear();
      await options.pubSub?.close?.();
    },
  };
}

export interface WebSocketHeartbeatOptions {
  /** Interval in ms between outbound `ws.ping()` frames (default: `30_000`). */
  readonly heartbeatIntervalMs?: number;
  /** Maximum time in ms to wait for a client pong/activity after a ping before closing (default: `10_000`). */
  readonly pongTimeoutMs?: number;
  /** Optional maximum time in ms without any inbound message activity before closing with 1000 (`Idle timeout`). */
  readonly idleTimeoutMs?: number;
  /** Optional `RealtimeHub` to automatically clean up room memberships when a connection closes or times out. */
  readonly hub?: RealtimeHub;
  /** Optional custom ping payload. */
  readonly pingPayload?: WebSocketMessageData;
  /** When `true` (default), starts a background timer automatically when the first connection opens. */
  readonly autoStartTimer?: boolean;
  /** Optional injectable clock for deterministic tests (default: `Date.now`). */
  readonly clock?: () => number;
}

export interface WebSocketHeartbeatManager {
  track(ws: WebSocketConnection): void;
  untrack(wsOrId: WebSocketConnection | string): void;
  recordPong(wsOrId: WebSocketConnection | string): void;
  recordActivity(wsOrId: WebSocketConnection | string): void;
  /** Executes one deterministic check cycle: evicts timed-out sockets and sends due pings. Returns evicted count. */
  tick(nowMs?: number): number;
  /** Wraps a `WebSocketHandlers` object to automatically manage tracking, activity, pong, and hub cleanup. */
  wrapHandlers(handlers: WebSocketHandlers): WebSocketHandlers;
  trackedCount(): number;
  start(): void;
  stop(): void;
}

interface TrackedSocketRecord {
  readonly ws: WebSocketConnection;
  lastActivityAt: number;
  lastPingSentAt: number | null;
  awaitingPongSince: number | null;
}

export function createWebSocketHeartbeat(
  options: WebSocketHeartbeatOptions = {},
): WebSocketHeartbeatManager {
  const heartbeatIntervalMs = Math.max(10, options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS);
  const pongTimeoutMs = Math.max(10, options.pongTimeoutMs ?? DEFAULT_PONG_TIMEOUT_MS);
  const idleTimeoutMs = options.idleTimeoutMs;
  const autoStartTimer = options.autoStartTimer ?? true;
  const clock = options.clock ?? (() => Date.now());

  const tracked = new Map<string, TrackedSocketRecord>();
  let timer: ReturnType<typeof setInterval> | null = null;

  function stop(): void {
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  }

  function start(): void {
    if (timer !== null) return;
    const checkPeriod = Math.max(10, Math.min(heartbeatIntervalMs, pongTimeoutMs));
    timer = setInterval(() => {
      tick();
    }, checkPeriod);
    if (typeof timer === 'object' && timer !== null && 'unref' in timer) {
      (timer as { unref?: () => void }).unref?.();
    }
  }

  function untrack(wsOrId: WebSocketConnection | string): void {
    const id = resolveConnectionId(wsOrId);
    tracked.delete(id);
    if (tracked.size === 0) {
      stop();
    }
  }

  function tick(explicitNowMs?: number): number {
    const now = explicitNowMs ?? clock();
    let evicted = 0;

    for (const [id, rec] of Array.from(tracked.entries())) {
      if (rec.ws.readyState !== 'open') {
        tracked.delete(id);
        void options.hub?.leaveAll(id);
        continue;
      }

      if (rec.awaitingPongSince !== null && now - rec.awaitingPongSince >= pongTimeoutMs) {
        tracked.delete(id);
        evicted += 1;
        void options.hub?.leaveAll(id);
        rec.ws.close(1001, 'Heartbeat timeout');
        continue;
      }

      if (
        idleTimeoutMs !== undefined &&
        idleTimeoutMs > 0 &&
        now - rec.lastActivityAt >= idleTimeoutMs
      ) {
        tracked.delete(id);
        evicted += 1;
        void options.hub?.leaveAll(id);
        rec.ws.close(1000, 'Idle timeout');
        continue;
      }

      const lastPingOrJoin = rec.lastPingSentAt ?? rec.lastActivityAt;
      if (now - lastPingOrJoin >= heartbeatIntervalMs) {
        rec.lastPingSentAt = now;
        if (rec.awaitingPongSince === null) {
          rec.awaitingPongSince = now;
        }
        rec.ws.ping(options.pingPayload);
      }
    }

    if (tracked.size === 0) {
      stop();
    }

    return evicted;
  }

  return {
    track(ws: WebSocketConnection): void {
      const now = clock();
      tracked.set(ws.id, {
        ws,
        lastActivityAt: now,
        lastPingSentAt: null,
        awaitingPongSince: null,
      });
      if (autoStartTimer) {
        start();
      }
    },

    untrack,

    recordPong(wsOrId: WebSocketConnection | string): void {
      const id = resolveConnectionId(wsOrId);
      const rec = tracked.get(id);
      if (!rec) return;
      rec.awaitingPongSince = null;
      rec.lastActivityAt = clock();
    },

    recordActivity(wsOrId: WebSocketConnection | string): void {
      const id = resolveConnectionId(wsOrId);
      const rec = tracked.get(id);
      if (!rec) return;
      rec.lastActivityAt = clock();
      rec.awaitingPongSince = null;
    },

    tick,

    wrapHandlers(handlers: WebSocketHandlers): WebSocketHandlers {
      return {
        ...(handlers.authenticate !== undefined ? { authenticate: handlers.authenticate } : {}),
        onOpen: async (ws: WebSocketConnection, ctx: WebSocketUpgradeContext): Promise<void> => {
          this.track(ws);
          await handlers.onOpen?.(ws, ctx);
        },
        onMessage: async (ws: WebSocketConnection, message: WebSocketMessageData): Promise<void> => {
          this.recordActivity(ws);
          await handlers.onMessage?.(ws, message);
        },
        onPong: async (ws: WebSocketConnection, data: Uint8Array): Promise<void> => {
          this.recordPong(ws);
          await handlers.onPong?.(ws, data);
        },
        onClose: async (ws: WebSocketConnection, info: WebSocketCloseInfo): Promise<void> => {
          this.untrack(ws);
          await options.hub?.leaveAll(ws);
          await handlers.onClose?.(ws, info);
        },
        ...(handlers.onError !== undefined ? { onError: handlers.onError } : {}),
      };
    },

    trackedCount(): number {
      return tracked.size;
    },

    start,
    stop,
  };
}

export function withRealtimeWebSocket(
  handlers: WebSocketHandlers,
  options: WebSocketHeartbeatOptions = {},
): WebSocketHandlers {
  return createWebSocketHeartbeat(options).wrapHandlers(handlers);
}

export type EventDispatcherRoomMapper<TPayload = unknown> =
  | string
  | ((payload: TPayload) => {
      readonly room: string;
      readonly event?: string;
      readonly id?: string;
      readonly data?: WebSocketMessageData | Record<string, unknown> | readonly unknown[];
    } | null);

export interface EventDispatcherRealtimeBridgeOptions<
  TEvents extends Record<string, unknown> = Record<string, unknown>,
> {
  readonly hub: RealtimeHub;
  readonly events: EventDispatcher<TEvents>;
  readonly topics: {
    readonly [K in keyof TEvents]?: EventDispatcherRoomMapper<TEvents[K]>;
  };
}

export interface EventDispatcherRealtimeBridgeHandle {
  dispose(): void;
}

/**
 * Bridges `@forge-fr/core` `EventDispatcher` domain events directly into `RealtimeHub`
 * room broadcasts so domain mutations automatically fan out to WebSocket and SSE clients.
 */
export function createEventDispatcherRealtimeBridge<
  TEvents extends Record<string, unknown> = Record<string, unknown>,
>(
  options: EventDispatcherRealtimeBridgeOptions<TEvents>,
): EventDispatcherRealtimeBridgeHandle {
  const unsubs: Array<() => void> = [];

  for (const [eventName, mapper] of Object.entries(options.topics)) {
    if (!mapper) continue;
    const unsub = options.events.on(eventName as keyof TEvents & string, async (payload) => {
      if (typeof mapper === 'string') {
        await options.hub.broadcast(
          mapper,
          typeof payload === 'object' && payload !== null
            ? (payload as Record<string, unknown>)
            : { value: payload },
          { event: eventName },
        );
        return;
      }
      const mapped = (mapper as (p: unknown) => ReturnType<Exclude<EventDispatcherRoomMapper, string>>)(
        payload,
      );
      if (!mapped) return;
      const body =
        mapped.data !== undefined
          ? mapped.data
          : typeof payload === 'object' && payload !== null
            ? (payload as Record<string, unknown>)
            : { value: payload };
      await options.hub.broadcast(mapped.room, body, {
        event: mapped.event ?? eventName,
        ...(mapped.id !== undefined ? { id: mapped.id } : {}),
      });
    });
    unsubs.push(unsub);
  }

  return {
    dispose(): void {
      while (unsubs.length > 0) {
        const fn = unsubs.pop();
        fn?.();
      }
    },
  };
}
