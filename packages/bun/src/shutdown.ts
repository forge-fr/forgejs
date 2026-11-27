export interface ProcessShutdownTarget {
  close(timeoutMs?: number): Promise<void>;
}

export type ShutdownSignal = 'SIGINT' | 'SIGTERM' | 'SIGQUIT';

export interface ProcessShutdownOptions {
  /** POSIX signals to listen for. Default: `['SIGINT', 'SIGTERM']`. */
  readonly signals?: readonly ShutdownSignal[];
  /** Drain timeout passed to `target.close(timeoutMs)`. Default: `5000`. */
  readonly timeoutMs?: number;
  /** Optional cleanup hook executed after `target.close()` completes. */
  readonly onShutdown?: (signal: ShutdownSignal) => Promise<void> | void;
  /** Optional error callback invoked if close/onShutdown rejects. */
  readonly onError?: (error: unknown, signal: ShutdownSignal) => void;
  /** Exit the process after graceful shutdown completes. Default: `false`. */
  readonly exitOnComplete?: boolean;
  /** Optional process exit code when `exitOnComplete` is `true`. Default: `0`. */
  readonly exitCode?: number;
  /** Custom process-like emitter (useful in tests). Defaults to `globalThis.process`. */
  readonly processRef?: ProcessLike;
}

export interface ProcessLike {
  on(event: string, listener: () => void): unknown;
  off?(event: string, listener: () => void): unknown;
  removeListener?(event: string, listener: () => void): unknown;
  exit?(code?: number): void;
}

export interface ProcessShutdownHandle {
  readonly shuttingDown: boolean;
  trigger(signal?: ShutdownSignal): Promise<void>;
  detach(): void;
}

const DEFAULT_SIGNALS: readonly ShutdownSignal[] = ['SIGINT', 'SIGTERM'];

export function attachProcessShutdown(
  target: ProcessShutdownTarget,
  options: ProcessShutdownOptions = {},
): ProcessShutdownHandle {
  const signals = options.signals ?? DEFAULT_SIGNALS;
  const timeoutMs = options.timeoutMs ?? 5_000;
  const exitOnComplete = options.exitOnComplete ?? false;
  const exitCode = options.exitCode ?? 0;
  const proc =
    options.processRef ??
    (globalThis as unknown as { readonly process?: ProcessLike }).process;

  let shutdownPromise: Promise<void> | null = null;
  let detached = false;
  const listeners = new Map<ShutdownSignal, () => void>();

  const detach = (): void => {
    if (detached) return;
    detached = true;
    if (!proc) {
      listeners.clear();
      return;
    }
    for (const [signal, listener] of listeners) {
      if (typeof proc.off === 'function') {
        proc.off(signal, listener);
      } else if (typeof proc.removeListener === 'function') {
        proc.removeListener(signal, listener);
      }
    }
    listeners.clear();
  };

  const trigger = (signal: ShutdownSignal = 'SIGTERM'): Promise<void> => {
    if (shutdownPromise !== null) {
      return shutdownPromise;
    }

    shutdownPromise = (async () => {
      detach();
      let failed = false;
      try {
        await target.close(timeoutMs);
        await options.onShutdown?.(signal);
      } catch (err: unknown) {
        failed = true;
        options.onError?.(err, signal);
      } finally {
        if (exitOnComplete && proc && typeof proc.exit === 'function') {
          proc.exit(failed ? 1 : exitCode);
        }
      }
    })();

    return shutdownPromise;
  };

  if (proc && typeof proc.on === 'function') {
    for (const signal of signals) {
      const listener = (): void => {
        void trigger(signal);
      };
      listeners.set(signal, listener);
      proc.on(signal, listener);
    }
  }

  return {
    get shuttingDown(): boolean {
      return shutdownPromise !== null;
    },
    trigger,
    detach,
  };
}
