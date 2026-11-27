export type EventMap = Record<string, unknown>;

export type EventHandler<TPayload> = (payload: TPayload) => void | Promise<void>;

export type EventErrorStrategy = 'fail-fast' | 'collect' | 'isolate';

export interface EventDispatcherOptions {
  readonly errorStrategy?: EventErrorStrategy;
  readonly concurrent?: boolean;
  readonly onError?: (error: unknown, eventName: string) => void;
}

export interface EventDispatcher<TEvents extends EventMap = EventMap> {
  on<K extends keyof TEvents & string>(
    event: K,
    handler: EventHandler<TEvents[K]>,
  ): () => void;
  once<K extends keyof TEvents & string>(
    event: K,
    handler: EventHandler<TEvents[K]>,
  ): () => void;
  off<K extends keyof TEvents & string>(
    event: K,
    handler: EventHandler<TEvents[K]>,
  ): void;
  emit<K extends keyof TEvents & string>(
    event: K,
    payload: TEvents[K],
  ): Promise<void>;
  listenerCount<K extends keyof TEvents & string>(event: K): number;
  clear<K extends keyof TEvents & string>(event?: K): void;
}

interface ListenerRecord {
  readonly original: EventHandler<unknown>;
  readonly wrapped: EventHandler<unknown>;
  readonly once: boolean;
}

export function createEventDispatcher<TEvents extends EventMap = EventMap>(
  options: EventDispatcherOptions = {},
): EventDispatcher<TEvents> {
  const errorStrategy: EventErrorStrategy = options.errorStrategy ?? 'fail-fast';
  const concurrent = options.concurrent ?? false;
  const listeners = new Map<string, ListenerRecord[]>();

  function removeRecord(event: string, record: ListenerRecord): void {
    const list = listeners.get(event);
    if (!list) return;
    const next = list.filter((item) => item !== record);
    if (next.length === 0) {
      listeners.delete(event);
    } else {
      listeners.set(event, next);
    }
  }

  function register<K extends keyof TEvents & string>(
    event: K,
    handler: EventHandler<TEvents[K]>,
    once: boolean,
  ): () => void {
    const typedHandler = handler as EventHandler<unknown>;
    const record: ListenerRecord = {
      original: typedHandler,
      wrapped: typedHandler,
      once,
    };
    const list = listeners.get(event);
    if (list) {
      list.push(record);
    } else {
      listeners.set(event, [record]);
    }
    return () => removeRecord(event, record);
  }

  return {
    on(event, handler) {
      return register(event, handler, false);
    },

    once(event, handler) {
      return register(event, handler, true);
    },

    off(event, handler) {
      const list = listeners.get(event);
      if (!list) return;
      const typedHandler = handler as EventHandler<unknown>;
      const next = list.filter((item) => item.original !== typedHandler);
      if (next.length === 0) {
        listeners.delete(event);
      } else {
        listeners.set(event, next);
      }
    },

    async emit(event, payload) {
      const current = listeners.get(event);
      if (!current || current.length === 0) {
        return;
      }

      // Snapshot prevents mutation issues if listeners unsubscribe during dispatch
      const snapshot = [...current];
      const errors: unknown[] = [];

      const runOne = async (record: ListenerRecord): Promise<void> => {
        if (record.once) {
          removeRecord(event, record);
        }
        await record.wrapped(payload);
      };

      if (concurrent) {
        const results = await Promise.allSettled(snapshot.map((rec) => runOne(rec)));
        for (const result of results) {
          if (result.status === 'rejected') {
            if (errorStrategy === 'isolate') {
              options.onError?.(result.reason, event);
            } else {
              errors.push(result.reason);
            }
          }
        }
      } else {
        for (const record of snapshot) {
          try {
            await runOne(record);
          } catch (err: unknown) {
            if (errorStrategy === 'fail-fast') {
              throw err;
            }
            if (errorStrategy === 'isolate') {
              options.onError?.(err, event);
            } else {
              errors.push(err);
            }
          }
        }
      }

      if (errors.length > 0) {
        if (errorStrategy === 'fail-fast') {
          throw errors[0];
        }
        throw new AggregateError(
          errors,
          `${errors.length} error(s) occurred while emitting event "${event}"`,
        );
      }
    },

    listenerCount(event) {
      return listeners.get(event)?.length ?? 0;
    },

    clear(event) {
      if (event === undefined) {
        listeners.clear();
      } else {
        listeners.delete(event);
      }
    },
  };
}
