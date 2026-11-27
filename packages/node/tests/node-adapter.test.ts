import { createNoopLogger } from '@forge-fr/core';
import { createHttpApp } from '@forge-fr/http';
import { runHttpAdapterContractSuite, runWebSocketContractSuite } from '@forge-fr/testing';
import { describe, expect, it } from 'vitest';
import { NodeAdapter, createNodeAdapter } from '../src/index.js';

describe('@forge-fr/node — Native Node.js HTTP Adapter', () => {
  it('passes the full shared HTTP adapter contract suite over real loopback sockets', async () => {
    const results = await runHttpAdapterContractSuite(() => createNodeAdapter());
    expect(results.length).toBeGreaterThanOrEqual(8);
    expect(results.every((r) => r.passed)).toBe(true);
  });

  it('passes the shared live WebSocket contract suite over real loopback TCP sockets', async () => {
    await runWebSocketContractSuite(() => createNodeAdapter());
  });

  it('rejects oversized adapter-level bodies, sanitizes forged Host headers, and supports AbortSignal shutdown', async () => {
    const adapter = new NodeAdapter();
    const app = createHttpApp({
      adapter,
      logger: createNoopLogger(),
      maxBodyBytes: 1024 * 1024,
    });

    app.get('/host-check', (ctx) => ctx.json({ host: ctx.url.host, path: ctx.path }));
    app.post('/limited', async (ctx) => ctx.text(await ctx.body.text()));

    const shutdownController = new AbortController();
    const addr = await app.listen({
      host: '127.0.0.1',
      port: 0,
      maxBodyBytes: 64,
      signal: shutdownController.signal,
    });

    try {
      // Adapter-level maxBodyBytes rejects oversized payload early with 413
      const bigRes = await fetch(`${addr.url}/limited`, {
        method: 'POST',
        body: 'a'.repeat(200),
      });
      expect(bigRes.status).toBe(413);
      await bigRes.text();

      const okRes = await fetch(`${addr.url}/host-check`);
      expect(okRes.status).toBe(200);
      const data = (await okRes.json()) as { host: string; path: string };
      expect(data.path).toBe('/host-check');
      expect(data.host).toContain('127.0.0.1');

      // Double listen throws explicit error
      await expect(adapter.listen(app.fetch, { port: 0 })).rejects.toThrow();

      // Trigger shutdown via AbortSignal
      shutdownController.abort();
      const deadline = Date.now() + 1000;
      while (adapter.isListening && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 15));
      }
      expect(adapter.isListening).toBe(false);
    } finally {
      await app.dispose();
    }
  });
});
