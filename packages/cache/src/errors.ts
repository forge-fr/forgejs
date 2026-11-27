import { ForgeError, type ForgeErrorOptions } from '@forge-fr/core';

export class CacheError extends ForgeError {
  public constructor(message: string, options: ForgeErrorOptions = {}) {
    super(message, {
      code: options.code ?? 'CACHE_ERROR',
      statusCode: options.statusCode ?? 500,
      expose: options.expose ?? false,
      ...options,
    });
  }
}

export class CacheKeyError extends CacheError {
  public constructor(message: string, details?: Record<string, unknown>) {
    super(message, {
      code: 'CACHE_KEY_ERROR',
      statusCode: 400,
      expose: true,
      ...(details !== undefined ? { details } : {}),
    });
  }
}
