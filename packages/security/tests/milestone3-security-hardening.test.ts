import { describe, expect, it } from 'vitest';
import { ConfigurationError } from '@forge-fr/core';
import { createHttpApp } from '@forge-fr/http';
import { createPluginTestHarness } from '@forge-fr/testing';
import {
  SecurityTokens,
  attachSecurity,
  createPostgresRateLimitStore,
  createRateLimitMiddleware,
  createRedisRateLimitStore,
  createSecurityMiddleware,
  createSecurityPlugin,
  createSlidingWindowMemoryRateLimitStore,
  extractClientIp,
  type PostgresRateLimitSqlLike,
  type RedisRateLimitClientLike,
} from '../src/index.js';

describe('Milestone 3 — Security Middleware Hardening & Distributed Rate-Limit Stores', () => {
  describe('SEC-03: Client IP extraction hardening (opt-in X-Real-IP)', () => {
    it('ignores spoofed X-Real-IP even when trustProxy is true unless trustRealIpHeader is explicitly enabled', async () => {
      const app = createHttpApp();
      app.get('/ip-default', (ctx) =>
        ctx.json({
          ip: extractClientIp(ctx, { trustProxy: true }),
        }),
      );
      app.get('/ip-real-optin', (ctx) =>
        ctx.json({
          ip: extractClientIp(ctx, { trustProxy: true, trustRealIpHeader: true }),
        }),
      );

      // Without X-Forwarded-For, X-Real-IP is NOT trusted by default
      const spoofedRes = await app.fetch(
        new Request('http://forge.local/ip-default', {
          headers: { 'x-real-ip': '203.0.113.99' },
        }),
        { remoteAddress: '10.0.0.5' },
      );
      expect(await spoofedRes.json()).toEqual({ ip: '10.0.0.5' });

      // When explicitly opted in, X-Real-IP is used as fallback when XFF is absent
      const optInRes = await app.fetch(
        new Request('http://forge.local/ip-real-optin', {
          headers: { 'x-real-ip': '198.51.100.42' },
        }),
        { remoteAddress: '10.0.0.5' },
      );
      expect(await optInRes.json()).toEqual({ ip: '198.51.100.42' });

      // X-Forwarded-For still takes precedence when present
      const xffRes = await app.fetch(
        new Request('http://forge.local/ip-real-optin', {
          headers: {
            'x-forwarded-for': '192.0.2.10, 10.0.0.1',
            'x-real-ip': '198.51.100.42',
          },
        }),
        { remoteAddress: '10.0.0.5' },
      );
      expect(await xffRes.json()).toEqual({ ip: '10.0.0.1' });
    });
  });

  describe('Sliding-window memory rate-limit store & deterministic clock', () => {
    it('blocks fixed-window 2x boundary bursts using weighted previous+current counters', () => {
      // Window = 1000ms, max = 5
      // Window 1: [1000, 2000), Window 2: [2000, 3000)
      let clock = 1900;
      const store = createSlidingWindowMemoryRateLimitStore({ now: () => clock });

      // Consume all 5 requests at the very end of Window 1 (t = 1900ms)
      for (let i = 0; i < 5; i += 1) {
        const res = store.consume('client-1', 1000, 5);
        expect(res.allowed).toBe(true);
      }

      // Immediately after window boundary (t = 2050ms -> 95% of Window 1 overlaps)
      // Fixed window would allow 5 more (10 in 150ms); sliding window MUST block!
      clock = 2050;
      const burstAttempt = store.consume('client-1', 1000, 5);
      expect(burstAttempt.allowed).toBe(false);
      expect(burstAttempt.remaining).toBe(0);

      // Advance to t = 2250ms (75% overlap -> weighted prev = 3.75; 3.75 + 1 = 4.75 <= 5 -> 1 allowed!)
      clock = 2250;
      const partialRecovery = store.consume('client-1', 1000, 5);
      expect(partialRecovery.allowed).toBe(true);
      expect(partialRecovery.remaining).toBe(0);

      // Another request at t = 2250ms -> 3.75 + 2 = 5.75 > 5 -> blocked
      expect(store.consume('client-1', 1000, 5).allowed).toBe(false);

      // Full window elapsed (t = 3000ms -> Window 3, prev=1, elapsed=0 -> 4 more allowed)
      clock = 3000;
      expect(store.consume('client-1', 1000, 5).allowed).toBe(true);
    });

    it('uses injected now() clock for deterministic Retry-After and RateLimit-Reset headers', async () => {
      let clock = 10_000;
      const app = createHttpApp();
      app.use(
        createRateLimitMiddleware({
          max: 1,
          windowMs: 10_000,
          algorithm: 'sliding-window',
          now: () => clock,
        }),
      );
      app.get('/ping', (ctx) => ctx.json({ ok: true }));

      const r1 = await app.fetch(new Request('http://forge.local/ping'), { remoteAddress: '1.2.3.4' });
      expect(r1.status).toBe(200);
      expect(r1.headers.get('ratelimit-reset')).toBe('10');

      clock = 13_000; // 7 seconds left in window
      const r2 = await app.fetch(new Request('http://forge.local/ping'), { remoteAddress: '1.2.3.4' });
      expect(r2.status).toBe(429);
      expect(r2.headers.get('retry-after')).toBe('7');
    });
  });

  describe('Distributed Redis & PostgreSQL rate-limit stores (contract tests)', () => {
    it('executes atomic Redis Lua scripts for sliding-window and fixed-window and sanitizes keys', async () => {
      const calls: Array<{ script: string; numKeys: number; args: readonly (string | number)[] }> = [];
      const kv = new Map<string, number>();

      const mockRedis: RedisRateLimitClientLike = {
        async eval(script: string, numKeys: number, ...args: readonly (string | number)[]) {
          calls.push({ script, numKeys, args });
          if (numKeys === 2) {
            const prevKey = String(args[0]);
            const currKey = String(args[1]);
            const windowMs = Number(args[2]);
            const max = Number(args[3]);
            const nowMs = Number(args[4]);
            const windowStartMs = Number(args[5]);
            const prev = kv.get(prevKey) ?? 0;
            const curr = kv.get(currKey) ?? 0;
            const weight = Math.max(0, 1 - (nowMs - windowStartMs) / windowMs);
            if (prev * weight + curr + 1 > max + 1e-9) {
              return [0, 0, windowStartMs + windowMs];
            }
            const nextCurr = curr + 1;
            kv.set(currKey, nextCurr);
            const remaining = Math.max(0, Math.floor(max - (prev * weight + nextCurr) + 1e-9));
            return [1, remaining, windowStartMs + windowMs];
          }
          const key = String(args[0]);
          const windowMs = Number(args[1]);
          const max = Number(args[2]);
          const nowMs = Number(args[3]);
          const next = (kv.get(key) ?? 0) + 1;
          kv.set(key, next);
          return [next <= max ? 1 : 0, Math.max(0, max - next), nowMs + windowMs];
        },
      };

      const clock = 50_000;
      const slidingStore = createRedisRateLimitStore({
        client: mockRedis,
        keyPrefix: 'app:rl:',
        algorithm: 'sliding-window',
        now: () => clock,
      });

      const r1 = await slidingStore.consume('user\r\n123', 1000, 2);
      expect(r1.allowed).toBe(true);
      expect(r1.remaining).toBe(1);
      // Key control characters sanitized
      expect(calls[0]?.args[1]).toBe('app:rl:user__123:50');

      const r2 = await slidingStore.consume('user\r\n123', 1000, 2);
      expect(r2.allowed).toBe(true);
      expect(r2.remaining).toBe(0);

      const r3 = await slidingStore.consume('user\r\n123', 1000, 2);
      expect(r3.allowed).toBe(false);
      expect(r3.remaining).toBe(0);

      // Fixed-window via sendCommand (node-redis v4 contract)
      const sendCommands: Array<readonly string[]> = [];
      const nodeRedisMock: RedisRateLimitClientLike = {
        async sendCommand(cmdArgs) {
          sendCommands.push(cmdArgs);
          return [1, 4, clock + 1000];
        },
      };
      const fixedStore = createRedisRateLimitStore({
        client: nodeRedisMock,
        algorithm: 'fixed-window',
        now: () => clock,
      });
      const rf = await fixedStore.consume('ip:1.2.3.4', 1000, 5);
      expect(rf.allowed).toBe(true);
      expect(rf.remaining).toBe(4);
      expect(sendCommands[0]?.[0]).toBe('EVAL');
      expect(sendCommands[0]?.[2]).toBe('1');
    });

    it('executes atomic PostgreSQL upsert SQL, validates table identifier, and supports ensureSchema/pruneExpired', async () => {
      // Rejects SQL injection in table name
      const dummySql: PostgresRateLimitSqlLike = {
        async query() {
          return { rows: [] };
        },
      };
      expect(() =>
        createPostgresRateLimitStore({
          sql: dummySql,
          tableName: 'rate_limits; DROP TABLE users;--',
        }),
      ).toThrow(ConfigurationError);

      // Stateful mock simulating PostgreSQL table semantics
      const rows = new Map<
        string,
        { window_index: number; current_count: number; previous_count: number; last_allowed: boolean; expires_at_ms: number }
      >();
      let schemaCreated = false;
      let clock = 20_000;

      const pgMock: PostgresRateLimitSqlLike = {
        async query(sql, params = []) {
          if (sql.startsWith('CREATE TABLE IF NOT EXISTS')) {
            schemaCreated = true;
            return { rows: [] };
          }
          if (sql.startsWith('DELETE FROM')) {
            const cutoff = Number(params[0]);
            let deleted = 0;
            for (const [k, row] of rows) {
              if (row.expires_at_ms <= cutoff) {
                rows.delete(k);
                deleted += 1;
              }
            }
            return { rows: [], rowCount: deleted };
          }
          // Sliding-window upsert simulation
          const key = String(params[0]);
          const windowIndex = Number(params[1]);
          const expiresAtMs = Number(params[2]);
          const max = Number(params[3]);
          const prevWeight = Number(params[4]);
          const existing = rows.get(key);
          if (!existing) {
            const created = {
              window_index: windowIndex,
              current_count: 1,
              previous_count: 0,
              last_allowed: true,
              expires_at_ms: expiresAtMs,
            };
            rows.set(key, created);
            return { rows: [created] };
          }
          const prev =
            existing.window_index === windowIndex
              ? existing.previous_count
              : existing.window_index === windowIndex - 1
                ? existing.current_count
                : 0;
          const curr = existing.window_index === windowIndex ? existing.current_count : 0;
          const allowed = prev * prevWeight + curr + 1 <= max + 1e-9;
          const updated = {
            window_index: windowIndex,
            current_count: allowed ? curr + 1 : curr,
            previous_count: prev,
            last_allowed: allowed,
            expires_at_ms: expiresAtMs,
          };
          rows.set(key, updated);
          return { rows: [updated] };
        },
      };

      const pgStore = createPostgresRateLimitStore({
        sql: pgMock,
        tableName: 'public.forge_rate_limits',
        algorithm: 'sliding-window',
        now: () => clock,
      });

      await pgStore.ensureSchema();
      expect(schemaCreated).toBe(true);

      const p1 = await pgStore.consume('acct-7', 1000, 2);
      expect(p1.allowed).toBe(true);
      expect(p1.remaining).toBe(1);

      const p2 = await pgStore.consume('acct-7', 1000, 2);
      expect(p2.allowed).toBe(true);
      expect(p2.remaining).toBe(0);

      const p3 = await pgStore.consume('acct-7', 1000, 2);
      expect(p3.allowed).toBe(false);
      expect(p3.remaining).toBe(0);

      // Advance past expiry and prune
      clock = 25_000;
      const pruned = await pgStore.pruneExpired();
      expect(pruned).toBe(1);
    });
  });

  describe('Unified security composition & preflight-aware attachSecurity()', () => {
    it('answers CORS preflight OPTIONS on GET-only routes with 204 (never 405) and preserves CORS headers on 429 & 500 errors', async () => {
      const app = createHttpApp();
      attachSecurity(app, {
        cors: {
          origin: 'https://app.forgejs.id',
          credentials: true,
          methods: ['GET', 'POST'],
        },
        rateLimit: {
          max: 1,
          windowMs: 60_000,
        },
        csrf: {
          cookieName: 'csrf_token',
        },
      });

      app.get('/items', (ctx) => ctx.json({ items: [] }));
      app.get('/boom', () => {
        throw new Error('Unexpected failure');
      });

      // 1. Preflight OPTIONS on GET-only /items succeeds with 204 (not 405!) and does NOT consume rate-limit quota
      const preflight = await app.fetch(
        new Request('http://forge.local/items', {
          method: 'OPTIONS',
          headers: {
            origin: 'https://app.forgejs.id',
            'access-control-request-method': 'GET',
          },
        }),
        { remoteAddress: '203.0.113.10' },
      );
      expect(preflight.status).toBe(204);
      expect(preflight.headers.get('access-control-allow-origin')).toBe('https://app.forgejs.id');
      expect(preflight.headers.get('access-control-allow-credentials')).toBe('true');
      expect(preflight.headers.get('x-content-type-options')).toBe('nosniff');

      // 2. Disallowed preflight origin rejected with 403
      const badPreflight = await app.fetch(
        new Request('http://forge.local/items', {
          method: 'OPTIONS',
          headers: {
            origin: 'https://evil.example',
            'access-control-request-method': 'GET',
          },
        }),
        { remoteAddress: '203.0.113.10' },
      );
      expect(badPreflight.status).toBe(403);

      // 3. First real GET /items succeeds (preflight didn't burn the max=1 quota)
      const okRes = await app.fetch(
        new Request('http://forge.local/items', {
          headers: { origin: 'https://app.forgejs.id' },
        }),
        { remoteAddress: '203.0.113.10' },
      );
      expect(okRes.status).toBe(200);
      expect(okRes.headers.get('access-control-allow-origin')).toBe('https://app.forgejs.id');

      // 4. Second GET /items triggers 429 RateLimitExceededError — MUST still carry CORS + security headers!
      const limitedRes = await app.fetch(
        new Request('http://forge.local/items', {
          headers: { origin: 'https://app.forgejs.id' },
        }),
        { remoteAddress: '203.0.113.10' },
      );
      expect(limitedRes.status).toBe(429);
      expect(limitedRes.headers.get('access-control-allow-origin')).toBe('https://app.forgejs.id');
      expect(limitedRes.headers.get('vary')).toContain('Origin');
      expect(limitedRes.headers.get('x-content-type-options')).toBe('nosniff');
      expect(limitedRes.headers.get('retry-after')).toBeTruthy();

      // 5. 500 Internal Server Error from route MUST still carry CORS headers (for a fresh client IP)
      const errRes = await app.fetch(
        new Request('http://forge.local/boom', {
          headers: { origin: 'https://app.forgejs.id' },
        }),
        { remoteAddress: '203.0.113.11' },
      );
      expect(errRes.status).toBe(500);
      expect(errRes.headers.get('access-control-allow-origin')).toBe('https://app.forgejs.id');
      expect(errRes.headers.get('x-content-type-options')).toBe('nosniff');
    });

    it('registers SecurityTokens.securityMiddleware in createSecurityPlugin and supports auto-attaching to app', async () => {
      const app = createHttpApp();
      app.get('/hello', (ctx) => ctx.json({ hello: 'world' }));

      const harness = createPluginTestHarness({
        plugin: createSecurityPlugin(),
        config: {
          app,
          cors: { origin: 'https://console.forgejs.id' },
          rateLimit: { max: 5, windowMs: 60_000, algorithm: 'sliding-window' },
        },
      });
      await harness.start();

      const unifiedMw = harness.kernel.container.resolve(SecurityTokens.securityMiddleware);
      expect(typeof unifiedMw).toBe('function');

      const standalone = createSecurityMiddleware({
        cors: { origin: 'https://console.forgejs.id' },
      });
      expect(typeof standalone).toBe('function');

      const preflight = await app.fetch(
        new Request('http://forge.local/hello', {
          method: 'OPTIONS',
          headers: {
            origin: 'https://console.forgejs.id',
            'access-control-request-method': 'GET',
          },
        }),
      );
      expect(preflight.status).toBe(204);
      expect(preflight.headers.get('access-control-allow-origin')).toBe('https://console.forgejs.id');

      await harness.dispose();
    });
  });
});
