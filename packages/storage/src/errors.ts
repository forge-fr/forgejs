import { ForgeError, type ForgeErrorOptions } from '@forge-fr/core';

export class StorageError extends ForgeError {
  public constructor(message: string, options: ForgeErrorOptions = {}) {
    super(message, {
      code: options.code ?? 'STORAGE_ERROR',
      statusCode: options.statusCode ?? 500,
      expose: options.expose ?? false,
      ...options,
    });
  }
}

export class StoragePathError extends StorageError {
  public constructor(message: string, details?: Record<string, unknown>) {
    super(message, {
      code: 'STORAGE_PATH_ERROR',
      statusCode: 400,
      expose: true,
      ...(details !== undefined ? { details } : {}),
    });
  }
}

export class StorageValidationError extends StorageError {
  public constructor(message: string, details?: Record<string, unknown>) {
    super(message, {
      code: 'STORAGE_VALIDATION_ERROR',
      statusCode: 400,
      expose: true,
      ...(details !== undefined ? { details } : {}),
    });
  }
}

export class StorageObjectNotFoundError extends StorageError {
  public constructor(key: string) {
    super(`Storage object "${key}" not found`, {
      code: 'STORAGE_OBJECT_NOT_FOUND',
      statusCode: 404,
      expose: true,
      details: { key },
    });
  }
}
