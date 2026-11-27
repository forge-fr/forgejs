import { ForgeError, type ForgeErrorOptions } from '@forge-fr/core';

export class RateLimitExceededError extends ForgeError {
  public readonly retryAfterSeconds: number;

  public constructor(
    retryAfterSeconds: number,
    message = 'Too many requests',
    options: Omit<ForgeErrorOptions, 'code' | 'statusCode'> = {},
  ) {
    super(message, {
      ...options,
      code: 'RATE_LIMIT_EXCEEDED',
      statusCode: 429,
      expose: options.expose ?? true,
    });
    this.retryAfterSeconds = Math.max(1, Math.ceil(retryAfterSeconds));
  }
}

export class SsrfBlockedError extends ForgeError {
  public constructor(
    message = 'Outbound request target is not permitted',
    options: Omit<ForgeErrorOptions, 'code' | 'statusCode'> = {},
  ) {
    super(message, {
      ...options,
      code: 'SSRF_BLOCKED',
      statusCode: 403,
      expose: options.expose ?? false,
    });
  }
}

export class PathTraversalError extends ForgeError {
  public constructor(
    message = 'Invalid or disallowed file path',
    options: Omit<ForgeErrorOptions, 'code' | 'statusCode'> = {},
  ) {
    super(message, {
      ...options,
      code: 'PATH_TRAVERSAL_BLOCKED',
      statusCode: 400,
      expose: options.expose ?? false,
    });
  }
}
