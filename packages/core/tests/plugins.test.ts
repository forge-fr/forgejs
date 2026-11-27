import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { createKernel, LifecycleError } from '../src/kernel.js';
import { createNoopLogger } from '../src/logger.js';
import {
  CircularPluginDependencyError,
  FORGE_CORE_VERSION,
  PluginCompatibilityError,
  PluginConflictError,
  PluginDefinitionError,
  PluginDependencyError,
  createPluginRegistry,
  definePlugin,
  type ForgePlugin,
} from '../src/plugins.js';

describe('@forge-fr/core Plugin Contract & Dependency Resolver (M3.1)', () => {
  it('validates and freezes declarative plugin definitions via definePlugin()', () => {
    const dbPlugin = definePlugin<{ url: string }>({
      name: '@forge-fr/database',
      version: '0.1.0',
      forgeVersion: '^0.1.0',
      capabilities: ['di:register', 'health:register'],
    });

    expect(Object.isFrozen(dbPlugin)).toBe(true);
    expect(dbPlugin.name).toBe('@forge-fr/database');
    expect(dbPlugin.version).toBe('0.1.0');
    expect(dbPlugin.forgeVersion).toBe('^0.1.0');
    expect(dbPlugin.capabilities).toEqual(['di:register', 'health:register']);

    // Invalid names (empty, whitespace, prototype-pollution keys)
    expect(() =>
      definePlugin({ name: '   ', version: '0.1.0', forgeVersion: '^0.1.0' }),
    ).toThrow(PluginDefinitionError);
    expect(() =>
      definePlugin({ name: '__proto__', version: '0.1.0', forgeVersion: '^0.1.0' }),
    ).toThrow(PluginDefinitionError);
    expect(() =>
      definePlugin({ name: 'constructor', version: '0.1.0', forgeVersion: '^0.1.0' }),
    ).toThrow(PluginDefinitionError);

    // Invalid version or forgeVersion range
    expect(() =>
      definePlugin({ name: 'bad-ver', version: '1.0', forgeVersion: '^0.1.0' }),
    ).toThrow(PluginDefinitionError);
    expect(() =>
      definePlugin({ name: 'bad-range', version: '0.1.0', forgeVersion: 'invalid!!' }),
    ).toThrow(PluginDefinitionError);

    // Invalid dependency range, self-dependency, self-conflict, and overlapping declarations
    expect(() =>
      definePlugin({
        name: 'a',
        version: '0.1.0',
        forgeVersion: '^0.1.0',
        dependencies: { b: 'not-a-range' },
      }),
    ).toThrow(PluginDefinitionError);

    expect(() =>
      definePlugin({
        name: 'self-dep',
        version: '0.1.0',
        forgeVersion: '^0.1.0',
        dependencies: ['self-dep'],
      }),
    ).toThrow(PluginDefinitionError);

    expect(() =>
      definePlugin({
        name: 'self-conflict',
        version: '0.1.0',
        forgeVersion: '^0.1.0',
        conflicts: ['self-conflict'],
      }),
    ).toThrow(PluginDefinitionError);

    expect(() =>
      definePlugin({
        name: 'overlap',
        version: '0.1.0',
        forgeVersion: '^0.1.0',
        dependencies: ['b'],
        optionalDependencies: ['b'],
      }),
    ).toThrow(PluginDefinitionError);

    expect(() =>
      definePlugin({
        name: 'contradict',
        version: '0.1.0',
        forgeVersion: '^0.1.0',
        dependencies: ['b'],
        conflicts: ['b'],
      }),
    ).toThrow(PluginDefinitionError);
  });

  it('enforces forgeVersion SemVer compatibility, duplicate detection, and bidirectional conflicts', () => {
    const registry = createPluginRegistry({ forgeVersion: '0.1.0' });

    const incompatible = definePlugin({
      name: 'future-plugin',
      version: '2.0.0',
      forgeVersion: '^2.0.0',
    });
    expect(() => registry.register(incompatible)).toThrow(PluginCompatibilityError);

    const p1 = definePlugin({ name: 'cache-redis', version: '1.0.0', forgeVersion: '^0.1.0 || ^1.0.0-rc.1' });
    registry.register(p1);
    expect(() => registry.register(p1)).toThrow(PluginConflictError);

    // Bidirectional conflict detection: p2 conflicts with p1 (registered after p1)
    const p2 = definePlugin({
      name: 'cache-memory',
      version: '1.0.0',
      forgeVersion: '^0.1.0 || ^1.0.0-rc.1',
      conflicts: ['cache-redis'],
    });
    registry.register(p2);
    expect(() => registry.resolve()).toThrow(PluginConflictError);

    // Reverse registration order: declaring plugin registered FIRST
    const revRegistry = createPluginRegistry({ forgeVersion: FORGE_CORE_VERSION });
    revRegistry.register(p2);
    revRegistry.register(p1);
    expect(() => revRegistry.resolve()).toThrow(PluginConflictError);
  });

  it('resolves topological dependency order, SemVer dependency checks, and optional dependencies', () => {
    const registry = createPluginRegistry({ forgeVersion: '0.1.0' });

    const telemetry = definePlugin({
      name: 'telemetry',
      version: '1.2.0',
      forgeVersion: '^0.1.0',
    });
    const database = definePlugin({
      name: 'database',
      version: '1.4.2',
      forgeVersion: '^0.1.0',
      optionalDependencies: { telemetry: '^1.0.0', missingOpt: '^1.0.0' },
    });
    const auth = definePlugin({
      name: 'auth',
      version: '1.0.0',
      forgeVersion: '^0.1.0',
      dependencies: { database: '^1.4.0' },
    });
    const api = definePlugin({
      name: 'api',
      version: '1.0.0',
      forgeVersion: '^0.1.0',
      dependencies: ['auth', 'database'],
    });

    // Register in reverse order to prove deterministic topological ordering
    registry.register(api);
    registry.register(auth);
    registry.register(database);
    registry.register(telemetry);

    const resolved = registry.resolve();
    expect(resolved.map((r) => r.plugin.name)).toEqual([
      'telemetry',
      'database',
      'auth',
      'api',
    ]);

    const dbEntry = resolved.find((r) => r.plugin.name === 'database')!;
    expect(dbEntry.resolvedOptionalDependencies).toEqual(['telemetry']);
    expect(dbEntry.missingOptionalDependencies).toEqual(['missingOpt']);
  });

  it('rejects missing required dependencies, SemVer dependency mismatches, and circular graphs', () => {
    // Missing required dependency
    const missingReg = createPluginRegistry({ forgeVersion: '0.1.0' });
    missingReg.register(
      definePlugin({
        name: 'auth',
        version: '1.0.0',
        forgeVersion: '^0.1.0',
        dependencies: { database: '^1.0.0' },
      }),
    );
    expect(() => missingReg.resolve()).toThrow(PluginDependencyError);

    // Required dependency SemVer mismatch
    const mismatchReg = createPluginRegistry({ forgeVersion: '0.1.0' });
    mismatchReg.register(
      definePlugin({ name: 'database', version: '0.9.0', forgeVersion: '^0.1.0' }),
    );
    mismatchReg.register(
      definePlugin({
        name: 'auth',
        version: '1.0.0',
        forgeVersion: '^0.1.0',
        dependencies: { database: '^1.0.0' },
      }),
    );
    expect(() => mismatchReg.resolve()).toThrow(PluginCompatibilityError);

    // Optional dependency SemVer mismatch when optional dependency IS installed
    const optMismatchReg = createPluginRegistry({ forgeVersion: '0.1.0' });
    optMismatchReg.register(
      definePlugin({ name: 'metrics', version: '2.0.0', forgeVersion: '^0.1.0' }),
    );
    optMismatchReg.register(
      definePlugin({
        name: 'http-plugin',
        version: '1.0.0',
        forgeVersion: '^0.1.0',
        optionalDependencies: { metrics: '^1.0.0' },
      }),
    );
    expect(() => optMismatchReg.resolve()).toThrow(PluginCompatibilityError);

    // Circular dependency trace
    const cycleReg = createPluginRegistry({ forgeVersion: '0.1.0' });
    cycleReg.register(
      definePlugin({ name: 'a', version: '1.0.0', forgeVersion: '^0.1.0', dependencies: ['b'] }),
    );
    cycleReg.register(
      definePlugin({ name: 'b', version: '1.0.0', forgeVersion: '^0.1.0', dependencies: ['c'] }),
    );
    cycleReg.register(
      definePlugin({ name: 'c', version: '1.0.0', forgeVersion: '^0.1.0', dependencies: ['a'] }),
    );

    let caught: unknown;
    try {
      cycleReg.resolve();
    } catch (err: unknown) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(CircularPluginDependencyError);
    expect((caught as CircularPluginDependencyError).chain).toEqual(['a', 'b', 'c', 'a']);
  });

  it('supports pre-start removePlugin() and forbids mutations after lock / kernel start', async () => {
    const pA = definePlugin({ name: 'a', version: '1.0.0', forgeVersion: '^0.1.0' });
    const pB = definePlugin({
      name: 'b',
      version: '1.0.0',
      forgeVersion: '^0.1.0',
      conflicts: ['a'],
    });
    const pC = definePlugin({
      name: 'c',
      version: '1.0.0',
      forgeVersion: '^0.1.0',
      dependencies: ['a'],
    });

    const kernel = createKernel({
      logger: createNoopLogger(),
      forgeVersion: '0.1.0',
    });

    kernel.plugin(pA).plugin(pB).plugin(pC);
    // Remove conflicting plugin B before start -> graph becomes valid!
    expect(kernel.removePlugin('b')).toBe(true);
    expect(kernel.removePlugin('nonexistent')).toBe(false);

    await kernel.register();
    expect(kernel.plugins.resolve().map((r) => r.plugin.name)).toEqual(['a', 'c']);

    // Removing required dependency A between register() and start() must fail fast on start()
    expect(kernel.removePlugin('a')).toBe(true);
    await expect(kernel.start()).rejects.toThrow(PluginDependencyError);
    expect(kernel.state).toBe('failed');
    await kernel.dispose();

    // Fresh kernel: verify plugin()/removePlugin() throw LifecycleError after start()
    const running = createKernel({
      logger: createNoopLogger(),
      forgeVersion: '0.1.0',
      plugins: [pA],
    });
    await running.start();
    expect(running.state).toBe('ready');
    expect(() => running.plugin(pB)).toThrow(LifecycleError);
    expect(() => running.removePlugin('a')).toThrow(LifecycleError);
    await running.dispose();
  });

  it('satisfies topological invariants across 50 randomly generated acyclic plugin DAGs', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 2, max: 10 }).chain((n) =>
          fc.tuple(
            fc.constant(n),
            fc.array(
              fc.tuple(
                fc.integer({ min: 0, max: n - 1 }),
                fc.integer({ min: 0, max: n - 1 }),
                fc.boolean(),
              ),
              { maxLength: 20 },
            ),
            fc.shuffledSubarray(
              Array.from({ length: n }, (_, i) => i),
              { minLength: n, maxLength: n },
            ),
          ),
        ),
        ([n, rawEdges, registerOrder]) => {
          // Only keep edges u -> v where u > v so the graph is guaranteed acyclic
          const deps = new Map<number, Set<number>>();
          const optDeps = new Map<number, Set<number>>();
          for (let i = 0; i < n; i += 1) {
            deps.set(i, new Set());
            optDeps.set(i, new Set());
          }
          for (const [u, v, isOpt] of rawEdges) {
            if (u <= v) continue;
            if (isOpt) {
              if (!deps.get(u)!.has(v)) optDeps.get(u)!.add(v);
            } else {
              optDeps.get(u)!.delete(v);
              deps.get(u)!.add(v);
            }
          }

          const registry = createPluginRegistry({ forgeVersion: '0.1.0' });
          const plugins: ForgePlugin[] = Array.from({ length: n }, (_, i) =>
            definePlugin({
              name: `p-${i}`,
              version: '1.0.0',
              forgeVersion: '^0.1.0',
              dependencies: Array.from(deps.get(i)!).map((d) => `p-${d}`),
              optionalDependencies: Array.from(optDeps.get(i)!).map((d) => `p-${d}`),
            }),
          );

          for (const idx of registerOrder) {
            registry.register(plugins[idx]!);
          }

          const resolved = registry.resolve();
          expect(resolved).toHaveLength(n);
          const pos = new Map<string, number>();
          resolved.forEach((entry, idx) => pos.set(entry.plugin.name, idx));

          for (let i = 0; i < n; i += 1) {
            const pPos = pos.get(`p-${i}`)!;
            for (const d of deps.get(i)!) {
              expect(pos.get(`p-${d}`)!).toBeLessThan(pPos);
            }
            for (const d of optDeps.get(i)!) {
              expect(pos.get(`p-${d}`)!).toBeLessThan(pPos);
            }
          }
        },
      ),
      { numRuns: 50 },
    );
  });
});
