import { describe, expect, it } from 'vitest';
import {
  createConsoleLogger,
  createNoopLogger,
  secret,
  type LogEntry,
} from '../src/index.js';

describe('@forge-fr/core — ForgeLogger & Security Log Redaction', () => {
  it('filters log entries strictly by configured minimum level', () => {
    const entries: LogEntry[] = [];
    const logger = createConsoleLogger({
      level: 'warn',
      sink: (entry) => entries.push(entry),
    });

    logger.debug('debug ignored');
    logger.info('info ignored');
    logger.warn('warn captured', { retryCount: 2 });
    logger.error('error captured', { code: 'E_FAIL' });
    logger.fatal('fatal captured');

    expect(entries.map((e) => e.level)).toEqual(['warn', 'error', 'fatal']);
    expect(entries[0]?.message).toBe('warn captured');
    expect(entries[0]?.context).toEqual({ retryCount: 2 });
  });

  it('creates isolated immutable child loggers that inherit parent bindings without mutating parent', () => {
    const entries: LogEntry[] = [];
    const root = createConsoleLogger({
      level: 'debug',
      bindings: { service: 'billing' },
      sink: (entry) => entries.push(entry),
    });

    const reqLogger = root.child({ requestId: 'req-42' });
    const subLogger = reqLogger.child({ userId: 'u-99' });

    root.info('root event');
    reqLogger.info('request event');
    subLogger.info('sub event');

    expect(entries[0]?.context).toEqual({ service: 'billing' });
    expect(entries[1]?.context).toEqual({ service: 'billing', requestId: 'req-42' });
    expect(entries[2]?.context).toEqual({ service: 'billing', requestId: 'req-42', userId: 'u-99' });
  });

  it('SECURITY: recursively redacts credentials, headers, tokens, SecretValue instances, and custom redactKeys', () => {
    const entries: LogEntry[] = [];
    const logger = createConsoleLogger({
      level: 'info',
      redactKeys: ['ssn', 'x-internal-key'],
      sink: (entry) => entries.push(entry),
    });

    logger.info('Incoming request', {
      headers: {
        Authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.secret',
        Cookie: 'session=abc123',
        'Set-Cookie': 'session=xyz789; HttpOnly',
        'X-Internal-Key': 'internal-only-token',
        'Content-Type': 'application/json',
      },
      body: {
        email: 'alice@example.com',
        password: 'CorrectHorseBatteryStaple',
        nested: {
          api_key: 'sk_live_9999',
          refreshToken: 'rt_8888',
          ssn: '123-45-6789',
          dbSecret: secret('postgres://user:pass@db/app'),
        },
      },
    });

    expect(entries).toHaveLength(1);
    const serialized = JSON.stringify(entries[0]);

    expect(serialized).not.toContain('eyJhbGciOiJIUzI1NiJ9');
    expect(serialized).not.toContain('session=abc123');
    expect(serialized).not.toContain('session=xyz789');
    expect(serialized).not.toContain('internal-only-token');
    expect(serialized).not.toContain('CorrectHorseBatteryStaple');
    expect(serialized).not.toContain('sk_live_9999');
    expect(serialized).not.toContain('rt_8888');
    expect(serialized).not.toContain('123-45-6789');
    expect(serialized).not.toContain('postgres://user:pass@db/app');

    expect(entries[0]?.context).toEqual({
      headers: {
        Authorization: '[REDACTED]',
        Cookie: '[REDACTED]',
        'Set-Cookie': '[REDACTED]',
        'X-Internal-Key': '[REDACTED]',
        'Content-Type': 'application/json',
      },
      body: {
        email: 'alice@example.com',
        password: '[REDACTED]',
        nested: {
          api_key: '[REDACTED]',
          refreshToken: '[REDACTED]',
          ssn: '[REDACTED]',
          dbSecret: '[REDACTED]',
        },
      },
    });
  });

  it('handles circular object references and Error instances safely without throwing', () => {
    const entries: LogEntry[] = [];
    const logger = createConsoleLogger({
      level: 'info',
      sink: (entry) => entries.push(entry),
    });

    const circular: Record<string, unknown> = { name: 'node-a' };
    circular.self = circular;

    expect(() =>
      logger.error('Failed operation', {
        circular,
        err: new Error('Boom'),
      }),
    ).not.toThrow();

    expect(entries).toHaveLength(1);
    expect(entries[0]?.context?.circular).toEqual({ name: 'node-a', self: '[Circular]' });
    expect(entries[0]?.context?.err).toMatchObject({ name: 'Error', message: 'Boom' });
  });

  it('provides createNoopLogger that supports all methods and child() without side effects', () => {
    const noop = createNoopLogger();
    const child = noop.child({ module: 'test' });
    expect(() => {
      noop.debug('a');
      noop.info('b');
      child.warn('c');
      child.error('d');
      child.fatal('e');
    }).not.toThrow();
  });
});
