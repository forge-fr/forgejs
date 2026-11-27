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

describe('@forge-fr/node attachProcessShutdown', () => {
  it('drains once on repeated SIGINT/SIGTERM signals and detaches cleanly', async () => {
    const proc = createMockProcess();
    let closes = 0;
    const seenSignals: string[] = [];

    const handle = attachProcessShutdown(
      {
        async close(timeoutMs) {
          expect(timeoutMs).toBe(1500);
          closes += 1;
          await new Promise((r) => setTimeout(r, 10));
        },
      },
      {
        processRef: proc,
        timeoutMs: 1500,
        exitOnComplete: true,
        exitCode: 0,
        onShutdown(signal) {
          seenSignals.push(signal);
        },
      },
    );

    expect(proc.listenerCount('SIGINT')).toBe(1);
    expect(proc.listenerCount('SIGTERM')).toBe(1);

    proc.emit('SIGTERM');
    proc.emit('SIGINT');
    await handle.trigger('SIGTERM');

    expect(handle.shuttingDown).toBe(true);
    expect(closes).toBe(1);
    expect(seenSignals).toEqual(['SIGTERM']);
    expect(proc.exitedWith).toBe(0);
    expect(proc.listenerCount('SIGINT')).toBe(0);
    expect(proc.listenerCount('SIGTERM')).toBe(0);
  });

  it('detaches listeners cleanly when detach() is called without triggering shutdown', () => {
    const proc = createMockProcess();
    let closes = 0;
    const handle = attachProcessShutdown(
      {
        async close() {
          closes += 1;
        },
      },
      { processRef: proc },
    );

    expect(proc.listenerCount('SIGTERM')).toBe(1);
    handle.detach();
    proc.emit('SIGTERM');
    expect(closes).toBe(0);
    expect(handle.shuttingDown).toBe(false);
  });
});
