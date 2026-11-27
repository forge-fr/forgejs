import { describe, expect, it } from 'vitest';
import {
  ConfigurationError,
  ConflictError,
  ForbiddenError,
  ForgeError,
  InternalError,
  NotFoundError,
  UnauthorizedError,
  ValidationError,
  isForgeError,
  normalizeError,
} from '../src/index.js';

describe('@forge-fr/core — ForgeError hierarchy & security sanitization', () => {
  it('constructs ForgeError with explicit code, statusCode, expose, details, and cause', () => {
    const rootCause = new Error('TCP reset on port 5432');
    const err = new ForgeError('Database timeout', {
      code: 'DB_TIMEOUT',
      statusCode: 504,
      expose: false,
      details: { host: '10.0.0.12' },
      cause: rootCause,
    });

    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(ForgeError);
    expect(err.name).toBe('ForgeError');
    expect(err.code).toBe('DB_TIMEOUT');
    expect(err.statusCode).toBe(504);
    expect(err.expose).toBe(false);
    expect(err.details).toEqual({ host: '10.0.0.12' });
    expect(err.cause).toBe(rootCause);
    expect(typeof err.timestamp).toBe('string');
  });

  it('defaults expose to true for 4xx client errors and false for 5xx server errors', () => {
    const badRequest = new ValidationError('Invalid email format', { field: 'email' });
    const notFound = new NotFoundError('User not found');
    const unauthorized = new UnauthorizedError();
    const forbidden = new ForbiddenError();
    const conflict = new ConflictError('Email already exists');
    const configErr = new ConfigurationError('Missing JWT_SECRET');
    const internal = new InternalError('Unhandled SQL exception: relation users does not exist');

    expect(badRequest.statusCode).toBe(400);
    expect(badRequest.expose).toBe(true);
    expect(notFound.statusCode).toBe(404);
    expect(notFound.expose).toBe(true);
    expect(unauthorized.statusCode).toBe(401);
    expect(unauthorized.expose).toBe(true);
    expect(forbidden.statusCode).toBe(403);
    expect(forbidden.expose).toBe(true);
    expect(conflict.statusCode).toBe(409);
    expect(conflict.expose).toBe(true);

    expect(configErr.statusCode).toBe(500);
    expect(configErr.expose).toBe(false);
    expect(internal.statusCode).toBe(500);
    expect(internal.expose).toBe(false);
  });

  it('SECURITY: strips internal messages, details, cause, and stack traces in production mode when expose is false', () => {
    const internal = new InternalError('SELECT * FROM secrets WHERE key="super-secret-123"', {
      details: { connectionString: 'postgres://admin:pass@internal:5432/prod' },
      cause: new Error('pg_hba.conf rejects host'),
    });

    const prodPayload = internal.toPublicJSON({ production: true, requestId: 'req_abc123' });

    expect(prodPayload).toEqual({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Internal Server Error',
        requestId: 'req_abc123',
      },
    });
    expect(JSON.stringify(prodPayload)).not.toContain('super-secret-123');
    expect(JSON.stringify(prodPayload)).not.toContain('postgres://');
    expect(JSON.stringify(prodPayload)).not.toContain('pg_hba');
    expect('stack' in prodPayload.error).toBe(false);
  });

  it('exposes safe details for client-exposed errors in production while never leaking stack traces', () => {
    const validation = new ValidationError('Payload validation failed', {
      issues: [{ path: 'email', message: 'Invalid email' }],
    });

    const prodPayload = validation.toPublicJSON({ production: true, requestId: 'req_val1' });

    expect(prodPayload).toEqual({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Payload validation failed',
        requestId: 'req_val1',
        details: { issues: [{ path: 'email', message: 'Invalid email' }] },
      },
    });
    expect('stack' in prodPayload.error).toBe(false);
  });

  it('normalizes unknown thrown values (Error, string, null, plain object) into safe ForgeError instances', () => {
    const existing = new NotFoundError('Item missing');
    expect(normalizeError(existing)).toBe(existing);
    expect(isForgeError(existing)).toBe(true);
    expect(isForgeError(new Error('plain'))).toBe(false);
    expect(isForgeError(null)).toBe(false);

    const fromNative = normalizeError(new TypeError('Cannot read properties of undefined'));
    expect(fromNative).toBeInstanceOf(InternalError);
    expect(fromNative.expose).toBe(false);
    expect(fromNative.statusCode).toBe(500);
    expect(fromNative.cause).toBeInstanceOf(TypeError);

    const fromString = normalizeError('raw string throw');
    expect(fromString).toBeInstanceOf(InternalError);
    expect(fromString.expose).toBe(false);
    expect(fromString.toPublicJSON({ production: true }).error.message).toBe('Internal Server Error');

    const fromNull = normalizeError(null);
    expect(fromNull).toBeInstanceOf(InternalError);
  });
});
