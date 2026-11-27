export interface ForgeErrorOptions {
  readonly code?: string;
  readonly statusCode?: number;
  readonly expose?: boolean;
  readonly details?: Record<string, unknown>;
  readonly cause?: unknown;
}

export interface PublicErrorSerializationOptions {
  readonly production?: boolean;
  readonly requestId?: string;
}

export interface PublicErrorBody {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly requestId?: string;
    readonly details?: Record<string, unknown>;
  };
}

const DEFAULT_PUBLIC_SERVER_MESSAGE = 'Internal Server Error';

export class ForgeError extends Error {
  public readonly code: string;
  public readonly statusCode: number;
  public readonly expose: boolean;
  public readonly details?: Record<string, unknown>;
  public readonly timestamp: string;

  public constructor(message: string, options: ForgeErrorOptions = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = new.target.name;
    this.statusCode = options.statusCode ?? 500;
    this.code = options.code ?? 'FORGE_ERROR';
    this.expose = options.expose ?? this.statusCode < 500;
    if (options.details !== undefined) {
      this.details = options.details;
    }
    this.timestamp = new Date().toISOString();

    if (typeof Object.setPrototypeOf === 'function') {
      Object.setPrototypeOf(this, new.target.prototype);
    }
  }

  public toPublicJSON(options: PublicErrorSerializationOptions = {}): PublicErrorBody {
    const production = options.production ?? true;
    const canExpose = this.expose || !production;

    const errorPayload: {
      code: string;
      message: string;
      requestId?: string;
      details?: Record<string, unknown>;
    } = {
      code: this.code,
      message: canExpose ? this.message : DEFAULT_PUBLIC_SERVER_MESSAGE,
    };

    if (options.requestId !== undefined) {
      errorPayload.requestId = options.requestId;
    }

    if (canExpose && this.details !== undefined) {
      errorPayload.details = this.details;
    }

    return { error: errorPayload };
  }
}

export class ConfigurationError extends ForgeError {
  public constructor(message: string, options: Omit<ForgeErrorOptions, 'code' | 'statusCode'> = {}) {
    super(message, {
      ...options,
      code: 'CONFIGURATION_ERROR',
      statusCode: 500,
      expose: options.expose ?? false,
    });
  }
}

export class ValidationError extends ForgeError {
  public constructor(
    message = 'Validation failed',
    details?: Record<string, unknown>,
    options: Omit<ForgeErrorOptions, 'code' | 'statusCode' | 'details'> = {},
  ) {
    super(message, {
      ...options,
      code: 'VALIDATION_ERROR',
      statusCode: 400,
      expose: options.expose ?? true,
      ...(details !== undefined ? { details } : {}),
    });
  }
}

export class UnauthorizedError extends ForgeError {
  public constructor(
    message = 'Unauthorized',
    options: Omit<ForgeErrorOptions, 'code' | 'statusCode'> = {},
  ) {
    super(message, {
      ...options,
      code: 'UNAUTHORIZED',
      statusCode: 401,
      expose: options.expose ?? true,
    });
  }
}

export class ForbiddenError extends ForgeError {
  public constructor(
    message = 'Forbidden',
    options: Omit<ForgeErrorOptions, 'code' | 'statusCode'> = {},
  ) {
    super(message, {
      ...options,
      code: 'FORBIDDEN',
      statusCode: 403,
      expose: options.expose ?? true,
    });
  }
}

export class NotFoundError extends ForgeError {
  public constructor(
    message = 'Resource not found',
    options: Omit<ForgeErrorOptions, 'code' | 'statusCode'> = {},
  ) {
    super(message, {
      ...options,
      code: 'NOT_FOUND',
      statusCode: 404,
      expose: options.expose ?? true,
    });
  }
}

export class ConflictError extends ForgeError {
  public constructor(
    message = 'Resource conflict',
    options: Omit<ForgeErrorOptions, 'code' | 'statusCode'> = {},
  ) {
    super(message, {
      ...options,
      code: 'CONFLICT',
      statusCode: 409,
      expose: options.expose ?? true,
    });
  }
}

export class InternalError extends ForgeError {
  public constructor(
    message = DEFAULT_PUBLIC_SERVER_MESSAGE,
    options: Omit<ForgeErrorOptions, 'code' | 'statusCode'> = {},
  ) {
    super(message, {
      ...options,
      code: 'INTERNAL_ERROR',
      statusCode: 500,
      expose: options.expose ?? false,
    });
  }
}

export function isForgeError(value: unknown): value is ForgeError {
  return value instanceof ForgeError;
}

export function normalizeError(value: unknown): ForgeError {
  if (isForgeError(value)) {
    return value;
  }

  if (value instanceof Error) {
    return new InternalError(value.message || DEFAULT_PUBLIC_SERVER_MESSAGE, {
      cause: value,
      expose: false,
    });
  }

  return new InternalError(DEFAULT_PUBLIC_SERVER_MESSAGE, {
    cause: value,
    expose: false,
  });
}
