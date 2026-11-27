import { QueueError } from './errors.js';
import type {
  JobHandler,
  QueueAdapter,
  QueueJob,
  QueueWorker,
  QueueWorkerOptions,
  QueueWorkerStopOptions,
} from './types.js';

export function createQueueWorker<TPayload = unknown, TResult = unknown>(
  queue: QueueAdapter,
  handler: JobHandler<TPayload, TResult>,
  options: QueueWorkerOptions = {},
): QueueWorker {
  const pollIntervalMs = options.pollIntervalMs ?? 25;
  const concurrency = options.concurrency ?? 4;
  const defaultTimeoutMs = options.defaultTimeoutMs;

  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new QueueError('Worker concurrency must be a positive integer', {
      statusCode: 400,
      expose: true,
    });
  }

  let isRunning = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pumpScheduled = false;
  const activeControllers = new Set<AbortController>();
  const activePromises = new Set<Promise<void>>();

  function schedulePump(delayMs: number): void {
    if (!isRunning) {
      return;
    }
    if (delayMs === 0) {
      if (pumpScheduled) {
        return;
      }
      pumpScheduled = true;
      queueMicrotask(() => {
        pumpScheduled = false;
        void pump();
      });
      return;
    }
    if (timer !== undefined) {
      return;
    }
    timer = setTimeout(() => {
      timer = undefined;
      void pump();
    }, delayMs);
  }

  async function executeJob(job: QueueJob): Promise<void> {
    const controller = new AbortController();
    activeControllers.add(controller);

    const effectiveTimeout = job.timeoutMs ?? defaultTimeoutMs;
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

    const timeoutPromise =
      effectiveTimeout !== undefined && effectiveTimeout > 0
        ? new Promise<never>((_, reject) => {
            timeoutHandle = setTimeout(() => {
              const err = new QueueError(
                `Job "${job.name}" (${job.id}) timed out after ${effectiveTimeout}ms`,
                { code: 'JOB_TIMEOUT' },
              );
              controller.abort(err);
              reject(err);
            }, effectiveTimeout);
          })
        : undefined;

    try {
      const workPromise = Promise.resolve(
        handler(job as QueueJob<TPayload, TResult>, {
          signal: controller.signal,
          attempt: job.attempts,
        }),
      );

      const result = timeoutPromise
        ? await Promise.race([workPromise, timeoutPromise])
        : await workPromise;

      // Prevent unhandled rejection if handler rejected shortly after abort
      const completed = await queue.complete(job.id, result);
      await options.onCompleted?.(completed);
    } catch (err: unknown) {
      const outcome = await queue.fail(job.id, err);
      await options.onFailed?.(outcome.job, err);
      if (outcome.status === 'dead') {
        await options.onDeadLetter?.(outcome.job, err);
      }
    } finally {
      if (timeoutHandle !== undefined) {
        clearTimeout(timeoutHandle);
      }
      activeControllers.delete(controller);
    }
  }

  async function pump(): Promise<void> {
    if (!isRunning) {
      return;
    }

    let dispatched = false;
    while (isRunning && activePromises.size < concurrency) {
      const job = await queue.dequeue();
      if (!job) {
        break;
      }
      dispatched = true;
      const promise = executeJob(job).finally(() => {
        activePromises.delete(promise);
        if (isRunning) {
          schedulePump(0);
        }
      });
      activePromises.add(promise);
    }

    if (isRunning && !dispatched && activePromises.size < concurrency) {
      schedulePump(pollIntervalMs);
    }
  }

  return {
    get running(): boolean {
      return isRunning;
    },

    get activeCount(): number {
      return activePromises.size;
    },

    start(): void {
      if (isRunning) {
        return;
      }
      isRunning = true;
      schedulePump(0);
    },

    async stop(stopOptions: QueueWorkerStopOptions = {}): Promise<void> {
      isRunning = false;
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }

      if (activePromises.size === 0) {
        return;
      }

      const timeoutMs = stopOptions.timeoutMs ?? 5000;
      const drainAll = Promise.allSettled(Array.from(activePromises));

      let drainTimeout: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<'timeout'>((resolve) => {
        drainTimeout = setTimeout(() => resolve('timeout'), timeoutMs);
      });

      const outcome = await Promise.race([
        drainAll.then(() => 'drained' as const),
        deadline,
      ]);

      if (drainTimeout !== undefined) {
        clearTimeout(drainTimeout);
      }

      if (outcome === 'timeout') {
        const shutdownErr = new QueueError('Worker shutdown drain window exceeded', {
          code: 'WORKER_SHUTDOWN_TIMEOUT',
        });
        for (const controller of activeControllers) {
          controller.abort(shutdownErr);
        }
        await drainAll;
      }
    },
  };
}
