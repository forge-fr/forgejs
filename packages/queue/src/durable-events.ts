import type { EventDispatcher } from '@forge-fr/core';
import { QueueValidationError } from './errors.js';
import type { OutboxTransactionHandle, TransactionalOutbox } from './outbox.js';
import { sanitizePayload, validateIdempotencyKey, validateJobName } from './sanitize.js';
import type {
  EnqueueOptions,
  JobExecutionContext,
  JobHandler,
  QueueAdapter,
  QueueJob,
  QueueWorker,
  QueueWorkerOptions,
} from './types.js';
import { createQueueWorker } from './worker.js';

export interface DurableEventJobPayload<TPayload = unknown> {
  readonly __forgeDurableEvent: true;
  readonly eventId: string;
  readonly topic: string;
  readonly data: TPayload;
  readonly emittedAt: number;
}

export interface DurableEventExecutionContext<TPayload = unknown> extends JobExecutionContext {
  readonly eventId: string;
  readonly topic: string;
  readonly emittedAt: number;
  readonly job: QueueJob<DurableEventJobPayload<TPayload>>;
}

export type DurableEventConsumer<TPayload = unknown> = (
  payload: TPayload,
  ctx: DurableEventExecutionContext<TPayload>,
) => Promise<void> | void;

export interface DurableEventTopicConfig<TPayload = unknown> {
  /** Override the queue job name for this event topic (default: `${jobPrefix}${topic}`). */
  readonly jobName?: string;
  /** Default `EnqueueOptions` (`maxAttempts`, `backoff`, `priority`, `timeoutMs`, `delayMs`) for this topic. */
  readonly enqueueOptions?: Omit<EnqueueOptions, 'idempotencyKey'>;
  /** Optional predicate; if it returns `false`, the emitted event is not enqueued. */
  readonly filter?: (payload: TPayload) => boolean;
  /** Optional payload transformer applied before enqueuing. */
  readonly transform?: (payload: TPayload) => unknown;
  /** Optional deterministic idempotency key extractor for deduplication. */
  readonly idempotencyKey?: (payload: TPayload) => string | undefined;
  /** Optional durable consumer handler executed when the queue worker processes this topic's job. */
  readonly handler?: DurableEventConsumer<TPayload>;
}

export type DurableEventTopicRule<TPayload = unknown> =
  | boolean
  | DurableEventConsumer<TPayload>
  | DurableEventTopicConfig<TPayload>;

export interface DurableEventPublishOptions extends EnqueueOptions {
  /** Optional transaction handle forwarded to `outbox.enqueue()` when an outbox is configured. */
  readonly tx?: OutboxTransactionHandle;
}

export interface DurableEventBridgeOptions<
  TEvents extends Record<string, unknown> = Record<string, unknown>,
> {
  /** Target `QueueAdapter` for durable event jobs. */
  readonly queue: QueueAdapter;
  /** Source `@forge-fr/core` `EventDispatcher` to bridge from. */
  readonly events?: EventDispatcher<TEvents>;
  /** Optional `TransactionalOutbox`; when provided, `publish()` with `{ tx }` stages through the outbox. */
  readonly outbox?: TransactionalOutbox;
  /** Prefix prepended to topic names to form queue job names (default: `'event:'`). */
  readonly jobPrefix?: string;
  /** Global default `EnqueueOptions` applied to all bridged event jobs. */
  readonly defaultEnqueueOptions?: Omit<EnqueueOptions, 'idempotencyKey'>;
  /** Map of event topics to bridge rules or durable handlers. */
  readonly topics?: {
    readonly [K in keyof TEvents]?: DurableEventTopicRule<TEvents[K]>;
  };
  /** Optional deterministic clock (default: `Date.now`). */
  readonly now?: () => number;
}

export interface DurableEventBridge<
  TEvents extends Record<string, unknown> = Record<string, unknown>,
> {
  /** Registers a durable consumer handler for `topic` and ensures `topic` is bridged from `EventDispatcher`. */
  on<K extends keyof TEvents & string>(
    topic: K,
    consumer: DurableEventConsumer<TEvents[K]>,
    config?: Omit<DurableEventTopicConfig<TEvents[K]>, 'handler'>,
  ): () => void;
  /** Enqueues a durable event job directly (or stages into `outbox` when `{ tx }` is provided). */
  publish<K extends keyof TEvents & string>(
    topic: K,
    payload: TEvents[K],
    options?: DurableEventPublishOptions,
  ): Promise<QueueJob<DurableEventJobPayload<TEvents[K]>>>;
  /** Creates a `JobHandler` that routes durable event jobs to registered consumers and delegates non-event jobs to `fallbackHandler`. */
  createJobHandler(fallbackHandler?: JobHandler): JobHandler;
  /** Creates a `QueueWorker` pre-wired to process durable event jobs from `queue`. */
  createWorker(workerOptions?: QueueWorkerOptions, fallbackHandler?: JobHandler): QueueWorker;
  /** Returns all Dead-Letter Queue jobs originating from this durable event bridge (optionally filtered by `topic`). */
  getDeadLetterEvents(
    topic?: keyof TEvents & string,
  ): Promise<readonly QueueJob<DurableEventJobPayload>[]>;
  /** Replays a specific dead-lettered durable event job by `jobId`. */
  replayDeadLetterEvent(jobId: string): Promise<QueueJob>;
  /** Replays all dead-lettered durable event jobs (optionally filtered by `topic`). */
  replayAllDeadLetterEvents(topic?: keyof TEvents & string): Promise<readonly QueueJob[]>;
  /** Unsubscribes all listeners attached to `EventDispatcher`. */
  dispose(): void;
}

function isDurableEventEnvelope(value: unknown): value is DurableEventJobPayload {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { __forgeDurableEvent?: unknown }).__forgeDurableEvent === true &&
    typeof (value as { topic?: unknown }).topic === 'string' &&
    typeof (value as { eventId?: unknown }).eventId === 'string'
  );
}

function normalizeTopicConfig<TPayload>(
  rule: DurableEventTopicRule<TPayload> | undefined,
): DurableEventTopicConfig<TPayload> | null {
  if (!rule) {
    return null;
  }
  if (rule === true) {
    return {};
  }
  if (typeof rule === 'function') {
    return { handler: rule };
  }
  return rule;
}

/**
 * Connects `@forge-fr/core` `EventDispatcher` domain topics to durable `@forge-fr/queue`
 * background jobs with automatic retry, backoff, idempotency, and Dead-Letter Queue recovery.
 */
export function createDurableEventBridge<
  TEvents extends Record<string, unknown> = Record<string, unknown>,
>(
  options: DurableEventBridgeOptions<TEvents>,
): DurableEventBridge<TEvents> {
  const { queue, events, outbox } = options;
  const jobPrefix = options.jobPrefix ?? 'event:';
  const defaultEnqueueOptions = options.defaultEnqueueOptions ?? {};
  const clock = options.now ?? (() => Date.now());

  const topicConfigs = new Map<string, DurableEventTopicConfig<unknown>>();
  const consumersByTopic = new Map<string, Set<DurableEventConsumer<unknown>>>();
  const jobNameToTopic = new Map<string, string>();
  const dispatcherUnsubs = new Map<string, () => void>();

  function resolveJobName(topic: string, cfg?: DurableEventTopicConfig<unknown>): string {
    const raw = cfg?.jobName ?? `${jobPrefix}${topic}`;
    const valid = validateJobName(raw);
    jobNameToTopic.set(valid, topic);
    return valid;
  }

  async function enqueueTopicEvent<TPayload>(
    topic: string,
    rawPayload: TPayload,
    explicitOpts?: DurableEventPublishOptions,
  ): Promise<QueueJob<DurableEventJobPayload<TPayload>> | undefined> {
    const cfg = topicConfigs.get(topic);
    if (cfg?.filter && !cfg.filter(rawPayload)) {
      return undefined;
    }

    const transformed = cfg?.transform ? cfg.transform(rawPayload) : rawPayload;
    const sanitizedData = sanitizePayload(transformed) as TPayload;
    const jobName = resolveJobName(topic, cfg);

    const extractedIdemp =
      explicitOpts?.idempotencyKey ??
      (cfg?.idempotencyKey ? cfg.idempotencyKey(rawPayload) : undefined);
    const idempotencyKey =
      extractedIdemp !== undefined ? validateIdempotencyKey(extractedIdemp) : undefined;

    const mergedOptions: EnqueueOptions = {
      ...defaultEnqueueOptions,
      ...(cfg?.enqueueOptions ?? {}),
      ...(explicitOpts ?? {}),
      ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
    };

    const envelope: DurableEventJobPayload<TPayload> = Object.freeze({
      __forgeDurableEvent: true,
      eventId: globalThis.crypto.randomUUID(),
      topic,
      data: sanitizedData,
      emittedAt: clock(),
    });

    // If an outbox AND a transaction handle (`tx`) are provided, write through the transactional outbox!
    if (outbox && explicitOpts?.tx !== undefined) {
      const outboxRec = await outbox.enqueue(jobName, envelope, {
        ...mergedOptions,
        tx: explicitOpts.tx,
      });
      return {
        id: outboxRec.id,
        name: jobName,
        payload: envelope,
        status: 'waiting',
        priority: outboxRec.priority,
        attempts: 0,
        maxAttempts: outboxRec.maxAttempts,
        ...(outboxRec.backoff !== undefined ? { backoff: outboxRec.backoff } : {}),
        ...(outboxRec.timeoutMs !== undefined ? { timeoutMs: outboxRec.timeoutMs } : {}),
        ...(outboxRec.idempotencyKey !== undefined
          ? { idempotencyKey: outboxRec.idempotencyKey }
          : {}),
        createdAt: outboxRec.createdAt,
        availableAt: outboxRec.availableAt,
      };
    }

    return queue.enqueue<DurableEventJobPayload<TPayload>>(jobName, envelope, mergedOptions);
  }

  function ensureDispatcherSubscription(topic: string): void {
    if (!events || dispatcherUnsubs.has(topic)) {
      return;
    }
    const unsub = events.on(topic as keyof TEvents & string, async (payload) => {
      await enqueueTopicEvent(topic, payload);
    });
    dispatcherUnsubs.set(topic, unsub);
  }

  function registerTopicInternal<TPayload>(
    topic: string,
    cfg: DurableEventTopicConfig<TPayload>,
  ): void {
    const existing = topicConfigs.get(topic) ?? {};
    const merged: DurableEventTopicConfig<unknown> = {
      ...existing,
      ...(cfg as DurableEventTopicConfig<unknown>),
    };
    topicConfigs.set(topic, merged);
    resolveJobName(topic, merged);

    if (cfg.handler) {
      let set = consumersByTopic.get(topic);
      if (!set) {
        set = new Set();
        consumersByTopic.set(topic, set);
      }
      set.add(cfg.handler as DurableEventConsumer<unknown>);
    }

    ensureDispatcherSubscription(topic);
  }

  if (options.topics) {
    for (const [topic, rule] of Object.entries(options.topics)) {
      const normalized = normalizeTopicConfig(rule as DurableEventTopicRule<unknown>);
      if (normalized) {
        registerTopicInternal(topic, normalized);
      }
    }
  }

  return {
    on<K extends keyof TEvents & string>(
      topic: K,
      consumer: DurableEventConsumer<TEvents[K]>,
      config?: Omit<DurableEventTopicConfig<TEvents[K]>, 'handler'>,
    ): () => void {
      registerTopicInternal(topic, {
        ...(config ?? {}),
        handler: consumer,
      });

      const set = consumersByTopic.get(topic);
      return () => {
        set?.delete(consumer as DurableEventConsumer<unknown>);
      };
    },

    async publish<K extends keyof TEvents & string>(
      topic: K,
      payload: TEvents[K],
      publishOpts?: DurableEventPublishOptions,
    ): Promise<QueueJob<DurableEventJobPayload<TEvents[K]>>> {
      if (!topicConfigs.has(topic)) {
        registerTopicInternal(topic, {});
      }
      const job = await enqueueTopicEvent(topic, payload, publishOpts);
      if (!job) {
        throw new QueueValidationError(
          `Durable event on topic "${topic}" was rejected by topic filter`,
        );
      }
      return job;
    },

    createJobHandler(fallbackHandler?: JobHandler): JobHandler {
      return async (job: QueueJob, ctx: JobExecutionContext): Promise<unknown> => {
        let envelope: DurableEventJobPayload | null = null;
        if (isDurableEventEnvelope(job.payload)) {
          envelope = job.payload;
        } else {
          const mappedTopic =
            jobNameToTopic.get(job.name) ??
            (job.name.startsWith(jobPrefix) ? job.name.slice(jobPrefix.length) : undefined);
          if (mappedTopic && consumersByTopic.has(mappedTopic)) {
            envelope = {
              __forgeDurableEvent: true,
              eventId: job.id,
              topic: mappedTopic,
              data: job.payload,
              emittedAt: job.createdAt,
            };
          }
        }

        if (!envelope) {
          if (fallbackHandler) {
            return await fallbackHandler(job, ctx);
          }
          throw new QueueValidationError(
            `No durable event consumer or fallback handler registered for job "${job.name}"`,
          );
        }

        const consumers = consumersByTopic.get(envelope.topic);
        if (!consumers || consumers.size === 0) {
          if (fallbackHandler) {
            return await fallbackHandler(job, ctx);
          }
          return {
            eventId: envelope.eventId,
            topic: envelope.topic,
            handledBy: 0,
          };
        }

        const eventCtx: DurableEventExecutionContext = {
          signal: ctx.signal,
          attempt: ctx.attempt,
          eventId: envelope.eventId,
          topic: envelope.topic,
          emittedAt: envelope.emittedAt,
          job: job as QueueJob<DurableEventJobPayload>,
        };

        let handledBy = 0;
        for (const consumer of Array.from(consumers)) {
          await consumer(envelope.data, eventCtx);
          handledBy += 1;
        }

        return {
          eventId: envelope.eventId,
          topic: envelope.topic,
          handledBy,
        };
      };
    },

    createWorker(workerOptions?: QueueWorkerOptions, fallbackHandler?: JobHandler): QueueWorker {
      return createQueueWorker(queue, this.createJobHandler(fallbackHandler), workerOptions);
    },

    async getDeadLetterEvents(
      topic?: keyof TEvents & string,
    ): Promise<readonly QueueJob<DurableEventJobPayload>[]> {
      const deadJobs = await queue.getDeadLetters();
      const matching: QueueJob<DurableEventJobPayload>[] = [];

      for (const job of deadJobs) {
        if (isDurableEventEnvelope(job.payload)) {
          if (topic === undefined || job.payload.topic === topic) {
            matching.push(job as QueueJob<DurableEventJobPayload>);
          }
          continue;
        }
        const mappedTopic =
          jobNameToTopic.get(job.name) ??
          (job.name.startsWith(jobPrefix) ? job.name.slice(jobPrefix.length) : undefined);
        if (mappedTopic !== undefined && (topic === undefined || mappedTopic === topic)) {
          matching.push({
            ...job,
            payload: {
              __forgeDurableEvent: true,
              eventId: job.id,
              topic: mappedTopic,
              data: job.payload,
              emittedAt: job.createdAt,
            },
          });
        }
      }

      return matching;
    },

    async replayDeadLetterEvent(jobId: string): Promise<QueueJob> {
      return queue.replayDeadLetter(jobId);
    },

    async replayAllDeadLetterEvents(
      topic?: keyof TEvents & string,
    ): Promise<readonly QueueJob[]> {
      const deadEvents = await this.getDeadLetterEvents(topic);
      const replayed: QueueJob[] = [];
      for (const job of deadEvents) {
        replayed.push(await queue.replayDeadLetter(job.id));
      }
      return replayed;
    },

    dispose(): void {
      for (const unsub of Array.from(dispatcherUnsubs.values())) {
        unsub();
      }
      dispatcherUnsubs.clear();
    },
  };
}
