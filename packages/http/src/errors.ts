import { ForgeError, type ForgeErrorOptions } from '@forge-fr/core';

export interface ForgeHttpErrorOptions extends ForgeErrorOptions {
  readonly headers?: Readonly<Record<string, string>>;
}

export class ForgeHttpError extends ForgeError {
  public readonly headers?: Readonly<Record<string, string>>;

  public constructor(message: string, options: ForgeHttpErrorOptions = {}) {
    super(message, options);
    if (options.headers !== undefined) {
      this.headers = { ...options.headers };
    }
  }
}

export class BadRequestError extends ForgeHttpError {
  public constructor(
    message = 'Bad Request',
    options: Omit<ForgeHttpErrorOptions, 'code' | 'statusCode'> = {},
  ) {
    super(message, {
      ...options,
      code: 'BAD_REQUEST',
      statusCode: 400,
      expose: options.expose ?? true,
    });
  }
}

export class MethodNotAllowedError extends ForgeHttpError {
  public readonly allowedMethods: readonly string[];

  public constructor(
    allowedMethods: readonly string[],
    allowHeader: string,
    message = 'Method Not Allowed',
  ) {
    super(message, {
      code: 'METHOD_NOT_ALLOWED',
      statusCode: 405,
      expose: true,
      headers: { allow: allowHeader },
      details: { allowedMethods: [...allowedMethods] },
    });
    this.allowedMethods = [...allowedMethods];
  }
}

export class NotAcceptableError extends ForgeHttpError {
  public constructor(
    message = 'Not Acceptable',
    options: Omit<ForgeHttpErrorOptions, 'code' | 'statusCode'> = {},
  ) {
    super(message, {
      ...options,
      code: 'NOT_ACCEPTABLE',
      statusCode: 406,
      expose: options.expose ?? true,
    });
  }
}

export class PayloadTooLargeError extends ForgeHttpError {
  public constructor(
    maxBytes?: number,
    message = 'Payload Too Large',
    options: Omit<ForgeHttpErrorOptions, 'code' | 'statusCode'> = {},
  ) {
    super(message, {
      ...options,
      code: 'PAYLOAD_TOO_LARGE',
      statusCode: 413,
      expose: options.expose ?? true,
      ...(maxBytes !== undefined ? { details: { maxBytes, ...(options.details ?? {}) } } : {}),
    });
  }
}

export class UnsupportedMediaTypeError extends ForgeHttpError {
  public constructor(
    message = 'Unsupported Media Type',
    options: Omit<ForgeHttpErrorOptions, 'code' | 'statusCode'> = {},
  ) {
    super(message, {
      ...options,
      code: 'UNSUPPORTED_MEDIA_TYPE',
      statusCode: 415,
      expose: options.expose ?? true,
    });
  }
}

export type MiddlewareErrorCode = 'NEXT_ALREADY_CALLED' | 'MIDDLEWARE_ERROR';

export class ForgeMiddlewareError extends ForgeHttpError {
  public constructor(
    code: MiddlewareErrorCode,
    message: string,
    options: Omit<ForgeHttpErrorOptions, 'code' | 'statusCode'> = {},
  ) {
    super(message, {
      ...options,
      code,
      statusCode: 500,
      expose: options.expose ?? false,
    });
  }
}

export class ResponseCommittedError extends ForgeHttpError {
  public constructor(
    message = 'Cannot mutate response status or headers after the response has been committed',
  ) {
    super(message, {
      code: 'RESPONSE_ALREADY_COMMITTED',
      statusCode: 500,
      expose: false,
    });
  }
}

export class ContextKeyNotFoundError extends ForgeHttpError {
  public readonly keyLabel: string;

  public constructor(keyLabel: string, message?: string) {
    super(
      message ?? `Required context key "${keyLabel}" has not been set on this request context`,
      {
        code: 'CONTEXT_KEY_NOT_FOUND',
        statusCode: 500,
        expose: false,
        details: { keyLabel },
      },
    );
    this.keyLabel = keyLabel;
  }
}
