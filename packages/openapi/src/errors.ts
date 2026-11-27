import { ForgeError, type ForgeErrorOptions } from '@forge-fr/core';

export class OpenApiError extends ForgeError {
  public constructor(message: string, options: ForgeErrorOptions = {}) {
    super(message, {
      code: options.code ?? 'OPENAPI_ERROR',
      statusCode: options.statusCode ?? 500,
      expose: options.expose ?? false,
      ...options,
    });
  }
}
