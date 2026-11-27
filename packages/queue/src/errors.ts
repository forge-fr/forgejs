import { ForgeError, type ForgeErrorOptions } from '@forge-fr/core';

export class QueueError extends ForgeError {
  public constructor(message: string, options: ForgeErrorOptions = {}) {
    super(message, {
      code: options.code ?? 'QUEUE_ERROR',
      statusCode: options.statusCode ?? 500,
      expose: options.expose ?? false,
      ...options,
    });
  }
}

export class QueueFullError extends QueueError {
  public constructor(message = 'Queue capacity limit reached', details?: Record<string, unknown>) {
    super(message, {
      code: 'QUEUE_FULL',
      statusCode: 429,
      expose: true,
      ...(details !== undefined ? { details } : {}),
    });
  }
}

export class QueueValidationError extends QueueError {
  public constructor(message: string, details?: Record<string, unknown>) {
    super(message, {
      code: 'QUEUE_VALIDATION_ERROR',
      statusCode: 400,
      expose: true,
      ...(details !== undefined ? { details } : {}),
    });
  }
}
