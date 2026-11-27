import { describe, expect, it } from 'vitest';
import {
  KernelConfigToken,
  KernelEventsToken,
  KernelLoggerToken,
  LifecycleError,
  createKernel,
  createNoopLogger,
  createToken,
  defineModule,
} from '../src/index.js';

describe('@forge-fr/core — 7-Stage Application Kernel Lifecycle', () => {
  it('executes all 7 lifecycle stages in deterministic topological order and reverse shutdown order', async () => {
    const trace: string[] = [];

    const DbModule = defineModule({
      name: 'db',
      onConfigure: () => {
        trace.push('configure:db');
      },
      onInit: (ctx) => {
        // Core global tokens must be visible in every module
        expect(ctx.resolve(KernelConfigToken).get<string>('env')).toBe('test');
        expect(ctx.resolve(KernelLoggerToken)).toBeDefined();
        expect(ctx.resolve(KernelEventsToken)).toBeDefined();
        trace.push('init:db');
      },
      onStart: () => {
        trace.push('start:db');
      },
      onReady: () => {
        trace.push('ready:db');
      },
      onShutdown: () => {
        trace.push('shutdown:db');
      },
    });

    const UsersModule = defineModule({
      name: 'users',
      imports: [DbModule],
      onConfigure: () => {
        trace.push('configure:users');
      },
      onInit: () => {
        trace.push('init:users');
      },
      onStart: () => {
        trace.push('start:users');
      },
      onReady: () => {
        trace.push('ready:users');
      },
      onShutdown: () => {
        trace.push('shutdown:users');
      },
    });

    const kernel = createKernel({
      config: { defaults: { env: 'test' } },
      logger: createNoopLogger(),
      modules: [UsersModule],
    });

    const stages: string[] = [];
    kernel.events.on('lifecycle:stage', (evt) => {
      stages.push(evt.to);
    });

    kernel.hooks.add('configure', () => {
      trace.push('hook:configure');
    });
    kernel.hooks.add('register', () => {
      trace.push('hook:register');
    });
    kernel.hooks.add('initialize', () => {
      trace.push('hook:initialize');
    });
    kernel.hooks.add('start', () => {
      trace.push('hook:start');
    });
    kernel.hooks.add('ready', () => {
      trace.push('hook:ready');
    });
    kernel.hooks.add('shutdown', () => {
      trace.push('hook:shutdown');
    });
    kernel.hooks.add('dispose', () => {
      trace.push('hook:dispose');
    });

    expect(kernel.state).toBe('created');
    await kernel.start();
    expect(kernel.state).toBe('ready');

    await kernel.dispose();
    expect(kernel.state).toBe('disposed');

    // Idempotent second shutdown/dispose must not re-run hooks
    await kernel.shutdown();
    await kernel.dispose();

    expect(trace).toEqual([
      'hook:configure',
      'configure:db',
      'configure:users',
      'hook:register',
      'init:db',
      'init:users',
      'hook:initialize',
      'start:db',
      'start:users',
      'hook:start',
      'ready:db',
      'ready:users',
      'hook:ready',
      'hook:shutdown',
      'shutdown:users',
      'shutdown:db',
      'hook:dispose',
    ]);

    expect(stages).toEqual([
      'configuring',
      'configured',
      'registering',
      'registered',
      'initializing',
      'initialized',
      'starting',
      'started',
      'ready',
      'shutting_down',
      'shutdown',
      'disposing',
      'disposed',
    ]);
  });

  it('rolls back already-initialized modules in reverse order when a later module fails during boot', async () => {
    const eventsLog: string[] = [];
    const ResourceToken = createToken<string>('Resource');

    const ModuleA = defineModule({
      name: 'mod-a',
      providers: [
        {
          token: ResourceToken,
          useFactory: () => {
            eventsLog.push('create:resource-a');
            return 'conn-a';
          },
          dispose: () => {
            eventsLog.push('dispose:resource-a');
          },
        },
      ],
      onInit: (ctx) => {
        ctx.resolve(ResourceToken);
        eventsLog.push('init:a');
      },
      onShutdown: () => {
        eventsLog.push('shutdown:a');
      },
    });

    const ModuleB = defineModule({
      name: 'mod-b',
      imports: [ModuleA],
      onInit: () => {
        eventsLog.push('init:b-fails');
        throw new Error('Database unreachable');
      },
      onShutdown: () => {
        eventsLog.push('shutdown:b-should-not-run');
      },
    });

    const kernel = createKernel({
      logger: createNoopLogger(),
      modules: [ModuleB],
    });

    const errorEvents: string[] = [];
    kernel.events.on('lifecycle:error', (e) => {
      errorEvents.push(e.stage);
    });

    await expect(kernel.start()).rejects.toThrow('Database unreachable');
    expect(kernel.state).toBe('failed');
    expect(errorEvents).toEqual(['initialize']);
    expect(eventsLog).toEqual([
      'create:resource-a',
      'init:a',
      'init:b-fails',
      'shutdown:a',
      'dispose:resource-a',
    ]);
  });

  it('continues shutting down remaining modules and disposing container even if one module shutdown throws', async () => {
    const calls: string[] = [];

    const BaseModule = defineModule({
      name: 'base',
      onShutdown: () => {
        calls.push('shutdown:base');
      },
    });

    const FailingShutdownModule = defineModule({
      name: 'failing-shutdown',
      imports: [BaseModule],
      onShutdown: () => {
        calls.push('shutdown:failing');
        throw new Error('flush failed');
      },
    });

    const kernel = createKernel({
      logger: createNoopLogger(),
      modules: [FailingShutdownModule],
    });

    await kernel.start();
    await expect(kernel.shutdown()).rejects.toBeInstanceOf(AggregateError);
    expect(calls).toEqual(['shutdown:failing', 'shutdown:base']);
    expect(kernel.state).toBe('shutdown');

    await kernel.dispose();
    expect(kernel.state).toBe('disposed');
  });

  it('rejects illegal lifecycle transitions and post-disposal operations with LifecycleError', async () => {
    const kernel = createKernel({ logger: createNoopLogger() });
    await kernel.start();

    expect(() => kernel.registerModule(defineModule({ name: 'too-late' }))).toThrow(LifecycleError);
    expect(kernel.createRequestScope().isRequestScope).toBe(true);

    await kernel.dispose();
    await expect(kernel.start()).rejects.toThrow(LifecycleError);
    expect(() => kernel.createRequestScope()).toThrow(LifecycleError);
  });
});
