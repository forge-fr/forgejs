import { describe, expect, it } from 'vitest';
import { attachProcessShutdown, type ProcessLike } from '../src/index.js';

function createMockProcess(): ProcessLike & {
  emit(signal: string): void;
  listenerCount(signal: string): number;
  exitedWith: number | undefined;
} {
  const map = new Map<string, Set<() => void>>();
  let exitedWith: number | undefined;

  return {
    get exitedWith() {
      return exitedWith;
    },
    on(event: string, listener: () => void) {
      let set = map.get(event);
      if (!set) {
        set = new Set();
        map.set(event, set);
      }
      set.add(listener);
    },
    off(event: string, listener: () => void) {
      map.get(event)?.delete(listener);
    },
    exit(code?: number) {
      exitedWith = code ?? 0;
    },
    emit(signal: string) {
      for (const fn of Array.from(map.get(signal) ?? [])) {
        fn();
      }
    },
    listenerCount(signal: string) {
      return map.get(signal)?.size ?? 0;
    },
  };
}

describe('@forge-fr/bun attachProcessShutdown', () => {
  it('idempotently drains server once on repeated signals and exits with code 1 on close error', async () => {
    const proc = createMockProcess();
    const errors: unknown[] = [];

    const handle = attachProcessShutdown(
      {
        async close() {
          throw new Error('drain failure');
        },
      },
      {
        processRef: proc,
        exitOnComplete: true,
        onError(err) {
          errors.push(err);
        },
      },
    );

    proc.emit('SIGINT');
    await handle.trigger('SIGINT');

    expect(errors).toHaveLength(1);
    expect(proc.exitedWith).toBe(1);
    expect(proc.listenerCount('SIGINT')).toBe(0);
    expect(proc.listenerCount('SIGTERM')).toBe(0);
  });
});
