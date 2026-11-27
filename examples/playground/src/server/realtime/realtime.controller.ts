import { extractBearerToken } from '@forge-fr/auth';
import {
  createCompressionMiddleware,
  createEtagMiddleware,
  negotiateContentType,
  type ForgeHttpApp,
} from '@forge-fr/http';
import { validatedOpenApiHandler } from '@forge-fr/openapi';
import { RealtimeServiceToken, type WsActorMeta } from './realtime.service.ts';

const csvEscape = (value: string): string => {
  if (value.includes(',') || value.includes('"') || value.includes('\n')) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
};

export function registerRealtimeController(app: ForgeHttpApp): void {
  const etagMiddleware = createEtagMiddleware({ weak: true });
  const compressionMiddleware = createCompressionMiddleware({ thresholdBytes: 128 });

  // Tenant-isolated native bidirectional WebSocket room (@forge-fr/http + @forge-fr/node)
  app.ws('/playground-api/ws', {
    async authenticate(ctx) {
      const realtime = app.kernel.container.resolve(RealtimeServiceToken);
      const rawToken =
        extractBearerToken(ctx.request) ?? ctx.query['access_token'] ?? null;
      if (!rawToken) return false;
      try {
        const actor = await realtime.authorizeWsToken(rawToken);
        ctx.state.set('wsActor', actor);
        return true;
      } catch {
        return false;
      }
    },
    onOpen(ws, ctx) {
      const realtime = app.kernel.container.resolve(RealtimeServiceToken);
      const actor = ctx.state.get('wsActor') as WsActorMeta | undefined;
      if (!actor) {
        ws.close(1008, 'Missing authenticated actor');
        return;
      }
      realtime.joinRoom(ws, actor);
    },
    onMessage(ws, message) {
      const realtime = app.kernel.container.resolve(RealtimeServiceToken);
      realtime.handleRoomMessage(ws, message);
    },
    onClose(ws) {
      const realtime = app.kernel.container.resolve(RealtimeServiceToken);
      realtime.leaveRoom(ws);
    },
  });

  app.group('/playground-api/http-demo', (group) => {
    group.get(
      '/etag-resource',
      validatedOpenApiHandler(
        {},
        (ctx) => {
          const realtime = ctx.resolve(RealtimeServiceToken);
          ctx.setHeader('cache-control', 'private, max-age=0, must-revalidate');
          return ctx.json(realtime.getEtagResource());
        },
        {
          summary: 'ETag conditional caching demo (returns weak W/"..." ETag and 304 Not Modified on If-None-Match)',
          tags: ['HTTP Edge'],
        },
      ),
      { middleware: [etagMiddleware] },
    );

    group.post(
      '/etag-bump',
      validatedOpenApiHandler(
        {},
        (ctx) => {
          const realtime = ctx.resolve(RealtimeServiceToken);
          return ctx.json(realtime.bumpEtagResource());
        },
        {
          summary: 'Increment ETag resource version so subsequent If-None-Match requests return 200 OK with new ETag',
          tags: ['HTTP Edge'],
        },
      ),
    );

    group.get(
      '/negotiate',
      validatedOpenApiHandler(
        {},
        (ctx) => {
          const realtime = ctx.resolve(RealtimeServiceToken);
          const offered = ['application/json', 'text/csv', 'text/plain'] as const;
          const selected = negotiateContentType(ctx.header('accept'), offered);
          const rows = realtime.getNegotiationSample(ctx.query['tenantId'] ?? 'tenant_acme');

          if (!selected) {
            return ctx.json(
              {
                error: {
                  code: 'NOT_ACCEPTABLE',
                  message: `Unsupported Accept header. Supported types: ${offered.join(', ')}`,
                },
              },
              { status: 406 },
            );
          }

          ctx.setHeader('vary', 'Accept');
          ctx.setHeader('x-negotiated-type', selected);

          if (selected === 'text/csv') {
            const header = 'id,tenantId,title,status,priority';
            const lines = rows.map(
              (r) =>
                `${csvEscape(r.id)},${csvEscape(r.tenantId)},${csvEscape(r.title)},${csvEscape(r.status)},${csvEscape(r.priority)}`,
            );
            return ctx.bytes(
              new TextEncoder().encode([header, ...lines].join('\n')),
              'text/csv; charset=utf-8',
            );
          }

          if (selected === 'text/plain') {
            const body = [
              `ForgeJS Content Negotiation Export (${rows.length} tasks)`,
              ...rows.map((r) => `- [${r.status}] (${r.priority}) ${r.title} (${r.id})`),
            ].join('\n');
            return ctx.text(body);
          }

          return ctx.json({
            negotiatedType: selected,
            count: rows.length,
            tasks: rows,
          });
        },
        {
          summary: 'RFC 9110 Accept content negotiation (JSON / CSV / Plain Text) + compression middleware',
          tags: ['HTTP Edge'],
        },
      ),
      { middleware: [compressionMiddleware] },
    );
  });
}
