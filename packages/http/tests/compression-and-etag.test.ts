import { describe, expect, it } from 'vitest';
import {
  createCompressionMiddleware,
  createEtagMiddleware,
  createHttpApp,
} from '../src/index.js';

describe('@forge-fr/http Compression & ETag Middleware', () => {
  it('compresses eligible JSON/text responses over threshold with gzip or deflate and preserves Vary', async () => {
    const app = createHttpApp();
    app.use(createCompressionMiddleware({ thresholdBytes: 128 }));

    const bigPayload = { message: 'hello world '.repeat(40) };
    app.get('/big', (ctx) => ctx.json(bigPayload));
    app.get('/small', (ctx) => ctx.json({ ok: true }));
    app.get('/events', (ctx) =>
      ctx.sse((stream) => {
        stream.send({ data: 'event-1 '.repeat(40) });
        stream.close();
      }),
    );

    await app.start();
    try {
      const gzipRes = await app.fetch(
        new Request('http://localhost/big', {
          headers: { 'accept-encoding': 'br;q=0.5, gzip;q=1.0, deflate;q=0.8' },
        }),
      );
      expect(gzipRes.status).toBe(200);
      expect(gzipRes.headers.get('content-encoding')).toBe('gzip');
      expect(gzipRes.headers.get('vary')).toContain('Accept-Encoding');

      const decompressed = await new Response(
        gzipRes.body!.pipeThrough(new DecompressionStream('gzip')),
      ).json();
      expect(decompressed).toEqual(bigPayload);

      const deflateRes = await app.fetch(
        new Request('http://localhost/big', {
          headers: { 'accept-encoding': 'deflate' },
        }),
      );
      expect(deflateRes.headers.get('content-encoding')).toBe('deflate');

      const smallRes = await app.fetch(
        new Request('http://localhost/small', {
          headers: { 'accept-encoding': 'gzip' },
        }),
      );
      expect(smallRes.headers.get('content-encoding')).toBeNull();
      expect(await smallRes.json()).toEqual({ ok: true });

      const sseRes = await app.fetch(
        new Request('http://localhost/events', {
          headers: { 'accept-encoding': 'gzip' },
        }),
      );
      expect(sseRes.headers.get('content-encoding')).toBeNull();
      expect(sseRes.headers.get('content-type')).toContain('text/event-stream');
    } finally {
      await app.dispose();
    }
  });

  it('computes SHA-256 ETags and returns 304 Not Modified on matching If-None-Match', async () => {
    const app = createHttpApp();
    app.use(createEtagMiddleware());

    app.get('/items', (ctx) => ctx.json({ items: [1, 2, 3] }));
    app.post('/items', (ctx) => ctx.json({ created: true }, { status: 201 }));

    await app.start();
    try {
      const first = await app.fetch(new Request('http://localhost/items'));
      expect(first.status).toBe(200);
      const etag = first.headers.get('etag');
      expect(etag).toMatch(/^W\/"[0-9a-f]{32}"$/);
      expect(await first.json()).toEqual({ items: [1, 2, 3] });

      const cached = await app.fetch(
        new Request('http://localhost/items', {
          headers: { 'if-none-match': `"other", ${etag!}` },
        }),
      );
      expect(cached.status).toBe(304);
      expect(cached.headers.get('etag')).toBe(etag);
      expect(await cached.text()).toBe('');

      const wildcard = await app.fetch(
        new Request('http://localhost/items', {
          headers: { 'if-none-match': '*' },
        }),
      );
      expect(wildcard.status).toBe(304);

      const created = await app.fetch(new Request('http://localhost/items', { method: 'POST' }));
      expect(created.status).toBe(201);
      expect(created.headers.get('etag')).toBeNull();
    } finally {
      await app.dispose();
    }
  });

  it('bypasses compression cleanly above maxBytes and keeps ETag/Vary RFC 9110 compliant', async () => {
    const app = createHttpApp();
    app.use(createCompressionMiddleware({ thresholdBytes: 32, maxBytes: 200 }));
    app.use(createEtagMiddleware({ weak: false }));

    const smallEnough = 'compressible-payload-'.repeat(4);
    const tooBig = 'oversized-stream-chunk-'.repeat(20);

    app.get('/within-cap', (ctx) => ctx.text(smallEnough));
    app.get('/stream-over-cap', (ctx) => {
      const encoder = new TextEncoder();
      const chunks = [encoder.encode(tooBig.slice(0, 150)), encoder.encode(tooBig.slice(150))];
      let idx = 0;
      return ctx.stream(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            if (idx < chunks.length) {
              controller.enqueue(chunks[idx++]!);
            } else {
              controller.close();
            }
          },
        }),
        'text/plain; charset=utf-8',
      );
    });

    await app.start();
    try {
      const compressed = await app.fetch(
        new Request('http://localhost/within-cap', {
          headers: { 'accept-encoding': 'gzip' },
        }),
      );
      expect(compressed.headers.get('content-encoding')).toBe('gzip');
      expect(compressed.headers.get('vary')).toContain('Accept-Encoding');
      // Strong ETag weakened per RFC 9110 when representation becomes content-encoded
      expect(compressed.headers.get('etag')).toMatch(/^W\/"[0-9a-f]{32}"$/);

      const passthrough = await app.fetch(
        new Request('http://localhost/stream-over-cap', {
          headers: { 'accept-encoding': 'gzip' },
        }),
      );
      expect(passthrough.status).toBe(200);
      expect(passthrough.headers.get('content-encoding')).toBeNull();
      expect(await passthrough.text()).toBe(tooBig);
    } finally {
      await app.dispose();
    }
  });
});
