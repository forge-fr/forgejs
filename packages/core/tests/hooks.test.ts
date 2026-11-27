import { describe, expect, it } from 'vitest';
import { ConflictError, createHookRegistry } from '../src/index.js';

interface LifecycleHooks {
  onInit: { steps: string[] };
  transformPayload: string;
}

describe('@forge-fr/core — HookRegistry', () => {
  it('executes sequential hooks in deterministic priority order with registration tie-breaking', async () => {
    const hooks = createHookRegistry<LifecycleHooks>();

    hooks.add('onInit', (ctx) => {
      ctx.steps.push('default-1');
    });
    hooks.add(
      'onInit',
      (ctx) => {
        ctx.steps.push('high-priority');
      },
      { id: 'auth-init', priority: -10 },
    );
    hooks.add('onInit', (ctx) => {
      ctx.steps.push('default-2');
    });
    hooks.add(
      'onInit',
      (ctx) => {
        ctx.steps.push('late');
      },
      { priority: 50 },
    );

    const context = { steps: [] as string[] };
    await hooks.runSequential('onInit', context);

    expect(context.steps).toEqual(['high-priority', 'default-1', 'default-2', 'late']);
  });

  it('supports waterfall value transformations across hooks', async () => {
    const hooks = createHookRegistry<LifecycleHooks>();

    hooks.add('transformPayload', (val) => `${val}:trim`, { priority: 1 });
    hooks.add('transformPayload', (val) => `${val}:escape`, { priority: 2 });
    hooks.add('transformPayload', () => undefined, { priority: 3 }); // preserves current value

    const result = await hooks.runWaterfall('transformPayload', 'raw');
    expect(result).toBe('raw:trim:escape');
  });

  it('rejects duplicate hook IDs and supports clean removal by ID', async () => {
    const hooks = createHookRegistry<LifecycleHooks>();

    hooks.add('onInit', (ctx) => ctx.steps.push('a'), { id: 'db-hook' });
    expect(() =>
      hooks.add('onInit', (ctx) => ctx.steps.push('b'), { id: 'db-hook' }),
    ).toThrow(ConflictError);

    expect(hooks.list('onInit')).toHaveLength(1);
    expect(hooks.remove('onInit', 'db-hook')).toBe(true);
    expect(hooks.remove('onInit', 'db-hook')).toBe(false);
    expect(hooks.list('onInit')).toHaveLength(0);
  });

  it('supports parallel execution for independent hooks', async () => {
    const hooks = createHookRegistry<LifecycleHooks>();
    const seen = new Set<string>();

    hooks.add('onInit', async () => {
      await Promise.resolve();
      seen.add('a');
    });
    hooks.add('onInit', async () => {
      await Promise.resolve();
      seen.add('b');
    });

    await hooks.runParallel('onInit', { steps: [] });
    expect(seen).toEqual(new Set(['a', 'b']));
  });
});
