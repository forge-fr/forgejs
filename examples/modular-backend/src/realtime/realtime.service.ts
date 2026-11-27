import { createToken } from '@forge-fr/core';
import type { WebSocketConnection } from '@forge-fr/http';
import { safeJsonParse } from '@forge-fr/security';
import type { AuthService } from '../auth/auth.service.ts';
import type { PlaygroundStore } from '../store.ts';

export interface EtagResourceState {
  readonly resourceId: string;
  readonly version: number;
  readonly updatedAt: string;
  readonly tenantCount: number;
  readonly totalTasks: number;
  readonly note: string;
}

export interface WsActorMeta {
  readonly tenantId: string;
  readonly actorName: string;
}

export interface RealtimeService {
  authorizeWsToken(rawToken: string): Promise<WsActorMeta>;
  joinRoom(ws: WebSocketConnection, actor: WsActorMeta): void;
  handleRoomMessage(ws: WebSocketConnection, rawData: string | Uint8Array): void;
  leaveRoom(ws: WebSocketConnection): void;
  getRoomCounts(): Readonly<Record<string, number>>;
  getEtagResource(): EtagResourceState;
  bumpEtagResource(): EtagResourceState;
  getNegotiationSample(tenantId?: string): readonly {
    readonly id: string;
    readonly tenantId: string;
    readonly title: string;
    readonly status: string;
    readonly priority: string;
  }[];
  resetRealtimeState(): void;
}

export const RealtimeServiceToken = createToken<RealtimeService>('playground:RealtimeService');

export interface RealtimeServiceDeps {
  readonly auth: AuthService;
  readonly store: PlaygroundStore;
}

export function createRealtimeService(deps: RealtimeServiceDeps): RealtimeService {
  const { auth, store } = deps;
  const rooms = new Map<string, Set<WebSocketConnection>>();
  let etagVersion = 1;
  let etagUpdatedAt = new Date().toISOString();

  function broadcastToRoom(tenantId: string, payload: Record<string, unknown>): void {
    const peers = rooms.get(tenantId);
    if (!peers || peers.size === 0) return;
    const serialized = JSON.stringify(payload);
    for (const peer of peers) {
      if (peer.readyState === 'open') {
        peer.send(serialized);
      }
    }
  }

  return {
    authorizeWsToken(rawToken: string) {
      return auth.verifySseToken(rawToken);
    },

    joinRoom(ws: WebSocketConnection, actor: WsActorMeta): void {
      ws.setState('wsActor', actor);
      let peers = rooms.get(actor.tenantId);
      if (!peers) {
        peers = new Set<WebSocketConnection>();
        rooms.set(actor.tenantId, peers);
      }
      peers.add(ws);

      ws.send(
        JSON.stringify({
          type: 'room.joined',
          connectionId: ws.id,
          tenantId: actor.tenantId,
          actorName: actor.actorName,
          onlineCount: peers.size,
          timestamp: new Date().toISOString(),
        }),
      );

      broadcastToRoom(actor.tenantId, {
        type: 'room.presence',
        tenantId: actor.tenantId,
        actorName: actor.actorName,
        onlineCount: peers.size,
        summary: `${actor.actorName} joined ${actor.tenantId} WebSocket room`,
        timestamp: new Date().toISOString(),
      });
    },

    handleRoomMessage(ws: WebSocketConnection, rawData: string | Uint8Array): void {
      const actor = ws.getState<WsActorMeta>('wsActor');
      if (!actor) return;

      const rawText = typeof rawData === 'string' ? rawData : new TextDecoder().decode(rawData);
      let text = rawText.trim();
      try {
        const parsed = safeJsonParse<{ text?: unknown }>(rawText);
        if (parsed && typeof parsed === 'object' && typeof parsed.text === 'string') {
          text = parsed.text.trim();
        }
      } catch {
        // Accept plain-text frames too
      }

      if (!text) return;
      const clamped = text.slice(0, 280);
      const peers = rooms.get(actor.tenantId);

      const frame = {
        type: 'room.message',
        id: `ws_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
        tenantId: actor.tenantId,
        actorName: actor.actorName,
        text: clamped,
        onlineCount: peers?.size ?? 1,
        timestamp: new Date().toISOString(),
      };

      broadcastToRoom(actor.tenantId, frame);

      store.publishEvent({
        tenantId: actor.tenantId,
        type: 'ws.broadcast',
        actorName: actor.actorName,
        summary: `WebSocket broadcast: "${clamped.slice(0, 60)}"`,
        data: { channel: actor.tenantId, length: clamped.length },
      });
    },

    leaveRoom(ws: WebSocketConnection): void {
      const actor = ws.getState<WsActorMeta>('wsActor');
      if (!actor) return;
      const peers = rooms.get(actor.tenantId);
      if (!peers) return;
      peers.delete(ws);
      if (peers.size === 0) {
        rooms.delete(actor.tenantId);
      } else {
        broadcastToRoom(actor.tenantId, {
          type: 'room.presence',
          tenantId: actor.tenantId,
          actorName: actor.actorName,
          onlineCount: peers.size,
          summary: `${actor.actorName} left ${actor.tenantId} WebSocket room`,
          timestamp: new Date().toISOString(),
        });
      }
    },

    getRoomCounts(): Readonly<Record<string, number>> {
      const out: Record<string, number> = {};
      for (const [tenantId, peers] of rooms.entries()) {
        out[tenantId] = peers.size;
      }
      return out;
    },

    getEtagResource(): EtagResourceState {
      return {
        resourceId: 'edge_snapshot_01',
        version: etagVersion,
        updatedAt: etagUpdatedAt,
        tenantCount: store.tenants.size,
        totalTasks: store.tasks.size,
        note: 'Send If-None-Match matching the response ETag header to receive HTTP 304 Not Modified.',
      };
    },

    bumpEtagResource(): EtagResourceState {
      etagVersion += 1;
      etagUpdatedAt = new Date().toISOString();
      return this.getEtagResource();
    },

    getNegotiationSample(tenantId = 'tenant_acme') {
      return store.listTasksForTenant(tenantId).map((t) => ({
        id: t.id,
        tenantId: t.tenantId,
        title: t.title,
        status: t.status,
        priority: t.priority,
      }));
    },

    resetRealtimeState(): void {
      etagVersion = 1;
      etagUpdatedAt = new Date().toISOString();
      for (const peers of rooms.values()) {
        for (const ws of Array.from(peers)) {
          ws.close(1000, 'Sandbox reset');
        }
      }
      rooms.clear();
    },
  };
}
