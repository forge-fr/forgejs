import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import * as v from 'valibot';
import { createToken } from '../src/di.js';
import { createKernel } from '../src/kernel.js';
import { createNoopLogger } from '../src/logger.js';
import { defineModule, ProviderNotVisibleError } from '../src/modules.js';
import {
  PluginCapabilityError,
  PluginConfigError,
  PluginEncapsulationError,
  definePlugin,
  type StandardSchemaLike,
} from '../src/plugins.js';

describe('@forge-fr/core Plugin Capability Enforcement, Config Validation & Lifecycle (M3.2)', () => {
  it('validates and transforms plugin config via Standard Schema v1 (Zod v4, Valibot v1 & async custom) at configure stage', async () => {
    const receivedConfigs: Record<string, unknown> = {};

    const zodPlugin = definePlugin({
      name: 'zod-plugin',
      version: '1.0.0',
      forgeVersion: '^0.1.0',
      configSchema: z.object({
        host: z.string().min(1),
        port: z.number().int().default(5432),
      }),
      register: (_ctx, cfg) => {
        receivedConfigs.zod = cfg;
      },
    });

    const valibotPlugin = definePlugin({
      name: 'valibot-plugin',
      version: '1.0.0',
      forgeVersion: '^0.1.0',
      configSchema: v.object({
        prefix: v.pipe(v.string(), v.minLength(2)),
      }),
      register: (_ctx, cfg) => {
        receivedConfigs.valibot = cfg;
      },
    });

    const asyncCustomSchema: StandardSchemaLike<unknown, { token: string }> = {
      '~standard': {
        version: 1,
        vendor: 'custom',
        validate: async (value) => {
          await Promise.resolve();
          if (typeof value === 'object' && value !== null && 'token' in value) {
            const raw = (value as { token: unknown }).token;
            if (typeof raw === 'string' && raw.length >= 3) {
              return { value: { token: raw.toUpperCase() } };
            }
          }
          return { issues: [{ message: 'token must be a string with at least 3 chars' }] };
        },
      },
    };

    const customPlugin = definePlugin({
      name: 'custom-plugin',
      version: '1.0.0',
      forgeVersion: '^0.1.0',
      configSchema: asyncCustomSchema,
      register: (_ctx, cfg) => {
        receivedConfigs.custom = cfg;
      },
    });

    const kernel = createKernel({ logger: createNoopLogger(), forgeVersion: '0.1.0' });
    kernel
      .plugin(zodPlugin, { host: 'db.internal' } as { host: string; port: number })
      .plugin(valibotPlugin, { prefix: 'api' })
      .plugin(customPlugin, { token: 'abc' });

    await kernel.start();
    expect(receivedConfigs).toEqual({
      zod: { host: 'db.internal', port: 5432 },
      valibot: { prefix: 'api' },
      custom: { token: 'ABC' },
    });
    await kernel.dispose();

    // Invalid config fails fast during configure() BEFORE register() runs
    let registerCalled = false;
    const badConfigPlugin = definePlugin({
      name: 'bad-cfg',
      version: '1.0.0',
      forgeVersion: '^0.1.0',
      configSchema: z.object({ port: z.number().int().min(1) }),
      register: () => {
        registerCalled = true;
      },
    });

    const failingKernel = createKernel({ logger: createNoopLogger(), forgeVersion: '0.1.0' });
    failingKernel.plugin(badConfigPlugin, { port: -10 });

    let caught: unknown;
    try {
      await failingKernel.configure();
    } catch (err: unknown) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PluginConfigError);
    expect((caught as PluginConfigError).pluginName).toBe('bad-cfg');
    expect((caught as PluginConfigError).issues.length).toBeGreaterThan(0);
    expect(registerCalled).toBe(false);
    expect(failingKernel.state).toBe('failed');
    await failingKernel.dispose();
  });

  it('enforces frozen capability-scoped PluginContext without leaking raw kernel internals', async () => {
    const DummyToken = createToken<string>('Dummy');

    const cases: {
      name: string;
      expectedCapability: string;
      action: (ctx: Parameters<NonNullable<ReturnType<typeof definePlugin>['register']>>[0]) => unknown;
    }[] = [
      {
        name: 'deny-di-register',
        expectedCapability: 'di:register',
        action: (ctx) => ctx.registerProvider({ token: DummyToken, useValue: 'x' }),
      },
      {
        name: 'deny-di-resolve',
        expectedCapability: 'di:resolve',
        action: (ctx) => ctx.resolve(DummyToken),
      },
      {
        name: 'deny-config-read',
        expectedCapability: 'config:read',
        action: (ctx) => ctx.getConfig('env'),
      },
      {
        name: 'deny-events-emit',
        expectedCapability: 'events:emit',
        action: (ctx) => ctx.emitEvent('custom:ping', { ok: true }),
      },
      {
        name: 'deny-events-listen',
        expectedCapability: 'events:listen',
        action: (ctx) => ctx.onEvent('lifecycle:stage', () => {}),
      },
      {
        name: 'deny-hooks-register',
        expectedCapability: 'hooks:register',
        action: (ctx) => ctx.addHook('ready', () => {}),
      },
      {
        name: 'deny-health-register',
        expectedCapability: 'health:register',
        action: (ctx) => ctx.registerHealthCheck('db', () => ({ status: 'ok' })),
      },
    ];

    for (const c of cases) {
      const p = definePlugin({
        name: c.name,
        version: '1.0.0',
        forgeVersion: '^0.1.0',
        capabilities: [], // explicitly zero capabilities
        register: async (ctx) => {
          expect(Object.isFrozen(ctx)).toBe(true);
          // Verify raw kernel internals are never attached to PluginContext
          expect('kernel' in ctx).toBe(false);
          expect('container' in ctx).toBe(false);
          expect('events' in ctx).toBe(false);
          expect('hooks' in ctx).toBe(false);
          expect('config' in ctx).toBe(false);
          await c.action(ctx);
        },
      });

      const k = createKernel({ logger: createNoopLogger(), forgeVersion: '0.1.0', plugins: [p] });
      let caught: unknown;
      try {
        await k.start();
      } catch (err: unknown) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(PluginCapabilityError);
      expect((caught as PluginCapabilityError).pluginName).toBe(c.name);
      expect((caught as PluginCapabilityError).capability).toBe(c.expectedCapability);
      await k.dispose();
    }
  });

  it('enforces strict plugin provider encapsulation and explicit exports across plugins and modules', async () => {
    const PrivateDbSecret = createToken<string>('PrivateDbSecret');
    const PublicDbPool = createToken<string>('PublicDbPool');

    const dbPlugin = definePlugin({
      name: 'db',
      version: '1.0.0',
      forgeVersion: '^0.1.0',
      capabilities: ['di:register', 'di:resolve', 'health:register'],
      register: (ctx) => {
        ctx.registerProvider({ token: PrivateDbSecret, useValue: 'secret-dsn' });
        ctx.registerProvider(
          {
            token: PublicDbPool,
            useFactory: (di) => `pool(${di.resolve(PrivateDbSecret)})`,
          },
          { export: true },
        );
        ctx.registerHealthCheck('db-pool', () => ({ status: 'ok', message: 'connected' }));
      },
      initialize: (ctx) => {
        // Owner plugin can resolve both its own private and exported tokens
        expect(ctx.resolve(PrivateDbSecret)).toBe('secret-dsn');
        expect(ctx.resolve(PublicDbPool)).toBe('pool(secret-dsn)');
      },
    });

    let authSawPool = '';
    const authPlugin = definePlugin({
      name: 'auth',
      version: '1.0.0',
      forgeVersion: '^0.1.0',
      dependencies: { db: '^1.0.0' },
      capabilities: ['di:resolve', 'config:read'],
      initialize: (ctx) => {
        // Dependent plugin CAN resolve exported token from dependency
        authSawPool = ctx.resolve(PublicDbPool);
        expect(ctx.getConfig<string>('appName')).toBe('forge-app');
        // Dependent plugin CANNOT resolve private token from dependency
        expect(() => ctx.resolve(PrivateDbSecret)).toThrow(PluginEncapsulationError);
      },
    });

    const unrelatedPlugin = definePlugin({
      name: 'unrelated',
      version: '1.0.0',
      forgeVersion: '^0.1.0',
      capabilities: ['di:resolve'],
      initialize: (ctx) => {
        // Unrelated plugin (did not declare dependency on db) CANNOT resolve db's exported token
        expect(() => ctx.resolve(PublicDbPool)).toThrow(PluginEncapsulationError);
      },
    });

    const appModule = defineModule({
      name: 'app',
      onInit: (ctx) => {
        // Application modules CAN resolve explicitly exported plugin tokens
        expect(ctx.resolve(PublicDbPool)).toBe('pool(secret-dsn)');
        // Application modules CANNOT resolve private plugin tokens
        expect(() => ctx.resolve(PrivateDbSecret)).toThrow(ProviderNotVisibleError);
      },
    });

    const kernel = createKernel({
      logger: createNoopLogger(),
      forgeVersion: '0.1.0',
      config: { values: { appName: 'forge-app' } },
      modules: [appModule],
      plugins: [authPlugin, unrelatedPlugin, dbPlugin],
    });

    await kernel.start();
    expect(authSawPool).toBe('pool(secret-dsn)');

    const health = await kernel.health.runAll();
    expect(health.status).toBe('ok');
    expect(health.checks['db-pool']?.status).toBe('ok');

    await kernel.dispose();

    // Verify a plugin cannot export a token owned by another plugin
    const hijacker = definePlugin({
      name: 'hijacker',
      version: '1.0.0',
      forgeVersion: '^0.1.0',
      dependencies: ['db'],
      capabilities: ['di:register'],
      register: (ctx) => {
        ctx.exportProvider(PublicDbPool);
      },
    });
    const hijackKernel = createKernel({
      logger: createNoopLogger(),
      forgeVersion: '0.1.0',
      plugins: [dbPlugin, hijacker],
    });
    await expect(hijackKernel.start()).rejects.toThrow(PluginEncapsulationError);
    await hijackKernel.dispose();
  });

  it('orchestrates plugin lifecycle hooks in topological order, reverse shutdown, and rollback on boot failure', async () => {
    const timeline: string[] = [];

    const pBase = definePlugin({
      name: 'base',
      version: '1.0.0',
      forgeVersion: '^0.1.0',
      capabilities: ['events:listen', 'events:emit', 'hooks:register', 'health:register'],
      register: (ctx) => {
        timeline.push('register:base');
        ctx.onEvent('custom:hello', () => {
          timeline.push('event:base');
        });
        ctx.addHook('ready', () => {
          timeline.push('hook-ready:base');
        });
        ctx.registerHealthCheck('base-health', () => ({ status: 'ok' }));
      },
      initialize: () => {
        timeline.push('init:base');
      },
      onReady: async (ctx) => {
        timeline.push('ready:base');
        await ctx.emitEvent('custom:hello', { from: 'base' });
      },
      onShutdown: () => {
        timeline.push('shutdown:base');
      },
    });

    const pChild = definePlugin({
      name: 'child',
      version: '1.0.0',
      forgeVersion: '^0.1.0',
      dependencies: ['base'],
      register: () => {
        timeline.push('register:child');
      },
      initialize: () => {
        timeline.push('init:child');
      },
      onReady: () => {
        timeline.push('ready:child');
      },
      onShutdown: () => {
        timeline.push('shutdown:child');
      },
    });

    const kernel = createKernel({
      logger: createNoopLogger(),
      forgeVersion: '0.1.0',
      plugins: [pChild, pBase],
    });
    await kernel.start();
    await kernel.shutdown();

    expect(timeline).toEqual([
      'register:base',
      'register:child',
      'init:base',
      'init:child',
      'ready:base',
      'event:base',
      'ready:child',
      'hook-ready:base',
      'shutdown:child',
      'shutdown:base',
    ]);

    // After shutdown, health check & event listener registered by base plugin are cleaned up
    const postShutdownHealth = await kernel.health.runAll();
    expect(Object.keys(postShutdownHealth.checks)).toEqual([]);
    await kernel.dispose();

    // Boot failure rollback: pFail fails during initialize -> pBase onShutdown MUST run
    const rollbackLog: string[] = [];
    const pHealthy = definePlugin({
      name: 'healthy',
      version: '1.0.0',
      forgeVersion: '^0.1.0',
      initialize: () => {
        rollbackLog.push('init:healthy');
      },
      onShutdown: () => {
        rollbackLog.push('rollback:healthy');
      },
    });
    const pFail = definePlugin({
      name: 'failing',
      version: '1.0.0',
      forgeVersion: '^0.1.0',
      dependencies: ['healthy'],
      initialize: () => {
        rollbackLog.push('init:failing');
        throw new Error('boom during plugin init');
      },
      onShutdown: () => {
        rollbackLog.push('should-not-run:failing');
      },
    });

    const rollbackKernel = createKernel({
      logger: createNoopLogger(),
      forgeVersion: '0.1.0',
      plugins: [pFail, pHealthy],
    });
    await expect(rollbackKernel.start()).rejects.toThrow('boom during plugin init');
    expect(rollbackKernel.state).toBe('failed');
    expect(rollbackLog).toEqual(['init:healthy', 'init:failing', 'rollback:healthy']);
    await rollbackKernel.dispose();
  });
});
