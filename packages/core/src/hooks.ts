import { ConflictError } from './errors.js';

export type HookMap = Record<string, unknown>;

export type HookHandler<TContext> = (
  context: TContext,
) => TContext | void | Promise<TContext | void>;

export interface HookRegistrationOptions {
  readonly id?: string;
  readonly priority?: number;
}

export interface HookEntryInfo {
  readonly id: string;
  readonly priority: number;
  readonly order: number;
}

export interface HookRegistry<THooks extends HookMap = HookMap> {
  add<K extends keyof THooks & string>(
    name: K,
    handler: HookHandler<THooks[K]>,
    options?: HookRegistrationOptions,
  ): string;
  remove<K extends keyof THooks & string>(name: K, id: string): boolean;
  list<K extends keyof THooks & string>(name: K): readonly HookEntryInfo[];
  runSequential<K extends keyof THooks & string>(name: K, context: THooks[K]): Promise<void>;
  runWaterfall<K extends keyof THooks & string>(name: K, initialValue: THooks[K]): Promise<THooks[K]>;
  runParallel<K extends keyof THooks & string>(name: K, context: THooks[K]): Promise<void>;
  clear<K extends keyof THooks & string>(name?: K): void;
}

interface InternalHookRecord {
  readonly id: string;
  readonly priority: number;
  readonly order: number;
  readonly handler: HookHandler<unknown>;
}

export function createHookRegistry<THooks extends HookMap = HookMap>(): HookRegistry<THooks> {
  const buckets = new Map<string, InternalHookRecord[]>();
  let sequence = 0;

  function sortBucket(records: InternalHookRecord[]): void {
    records.sort((a, b) => {
      if (a.priority !== b.priority) {
        return a.priority - b.priority;
      }
      return a.order - b.order;
    });
  }

  return {
    add(name, handler, options = {}) {
      const order = sequence;
      sequence += 1;
      const id = options.id ?? `hook_${name}_${order}`;
      const priority = options.priority ?? 0;

      const list = buckets.get(name) ?? [];
      if (list.some((item) => item.id === id)) {
        throw new ConflictError(`Hook with id "${id}" is already registered on "${name}"`);
      }

      list.push({
        id,
        priority,
        order,
        handler: handler as HookHandler<unknown>,
      });
      sortBucket(list);
      buckets.set(name, list);
      return id;
    },

    remove(name, id) {
      const list = buckets.get(name);
      if (!list) return false;
      const next = list.filter((item) => item.id !== id);
      if (next.length === list.length) {
        return false;
      }
      if (next.length === 0) {
        buckets.delete(name);
      } else {
        buckets.set(name, next);
      }
      return true;
    },

    list(name) {
      const list = buckets.get(name);
      if (!list) return [];
      return list.map(({ id, priority, order }) => ({ id, priority, order }));
    },

    async runSequential(name, context) {
      const list = buckets.get(name);
      if (!list || list.length === 0) return;
      const snapshot = [...list];
      for (const record of snapshot) {
        await record.handler(context);
      }
    },

    async runWaterfall(name, initialValue) {
      const list = buckets.get(name);
      if (!list || list.length === 0) return initialValue;
      const snapshot = [...list];
      let current: unknown = initialValue;
      for (const record of snapshot) {
        const next = await record.handler(current);
        if (next !== undefined) {
          current = next;
        }
      }
      return current as THooks[typeof name];
    },

    async runParallel(name, context) {
      const list = buckets.get(name);
      if (!list || list.length === 0) return;
      const snapshot = [...list];
      await Promise.all(snapshot.map((record) => record.handler(context)));
    },

    clear(name) {
      if (name === undefined) {
        buckets.clear();
      } else {
        buckets.delete(name);
      }
    },
  };
}
