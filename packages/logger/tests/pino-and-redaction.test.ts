import { secret } from '@forge-fr/core';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  createMemoryLogSink,
  createPinoLogger,
  sanitizeLogContext,
  sanitizeLogMessage,
} from '@forge-fr/logger';

describe('@forge-fr/logger — Pino Adapter & Secret/Injection Redaction', () => {
  it('emits structured JSON logs, respects levels, isolates child bindings, and flushes cleanly', async () => {
    const sink = createMemoryLogSink();
    const logger = createPinoLogger({
      name: 'billing-service',
      level: 'info',
      bindings: { env: 'production' },
      destination: sink.stream,
    });

    logger.debug('should be suppressed', { step: 1 });
    logger.info('invoice created', { invoiceId: 'inv_123', amount: 4200 });

    const child = logger.child({ module: 'payments', tenantId: 't_1' });
    child.warn('retrying gateway', { attempt: 2 });
    logger.error('parent still clean', { code: 'E_TEST' });

    await logger.flush();

    const entries = sink.entries();
    expect(entries).toHaveLength(3);
    expect(entries[0]).toMatchObject({
      name: 'billing-service',
      env: 'production',
      level: 'info',
      msg: 'invoice created',
      invoiceId: 'inv_123',
      amount: 4200,
    });
    expect(typeof entries[0]?.['time']).toBe('string');

    expect(entries[1]).toMatchObject({
      level: 'warn',
      module: 'payments',
      tenantId: 't_1',
      msg: 'retrying gateway',
      attempt: 2,
    });

    // Parent logger must not inherit child bindings
    expect(entries[2]?.['module']).toBeUndefined();
    expect(entries[2]?.['tenantId']).toBeUndefined();
  });

  it('recursively redacts SecretValue, sensitive keys, DB URLs, Bearer tokens, circular refs, and error stacks by default', () => {
    const sink = createMemoryLogSink();
    const logger = createPinoLogger({
      level: 'debug',
      redactKeys: ['tax_number'],
      destination: sink.stream,
    });

    const cyclic: Record<string, unknown> = { label: 'node-a' };
    cyclic['self'] = cyclic;

    const dbErr = new Error('Connection failed to postgres://admin:TopSecret99@db.internal:5432/prod');

    logger.error('user\r\nforged-line\0alert', {
      tokenSecret: secret('sk_live_very_secret_value'),
      nested: {
        password: 'plain-password-123',
        api_key: 'ak_99887766',
        taxNumber: 'TAX-9911',
        headers: {
          Authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig',
          'Set-Cookie': 'sid=abc123; HttpOnly',
        },
      },
      rawNote: 'Sent header Bearer super_secret_bearer_token and Basic dXNlcjpwYXNz',
      dsn: 'postgres://forge:Sup3rS3cret!@10.0.0.5:5432/forge_db',
      cyclic,
      err: dbErr,
    });

    const rawLine = sink.lines[0] ?? '';
    expect(rawLine).not.toContain('sk_live_very_secret_value');
    expect(rawLine).not.toContain('plain-password-123');
    expect(rawLine).not.toContain('ak_99887766');
    expect(rawLine).not.toContain('TAX-9911');
    expect(rawLine).not.toContain('eyJhbGciOiJIUzI1NiJ9');
    expect(rawLine).not.toContain('sid=abc123');
    expect(rawLine).not.toContain('super_secret_bearer_token');
    expect(rawLine).not.toContain('dXNlcjpwYXNz');
    expect(rawLine).not.toContain('Sup3rS3cret!');
    expect(rawLine).not.toContain('TopSecret99');

    // Single valid JSON line (no CRLF log forging split)
    const parsed = sink.entries()[0]!;
    expect(parsed['msg']).toBe('user\\r\\nforged-line\\0alert');
    expect(parsed['tokenSecret']).toBe('[REDACTED]');
    expect((parsed['nested'] as Record<string, unknown>)['password']).toBe('[REDACTED]');
    expect((parsed['nested'] as Record<string, unknown>)['api_key']).toBe('[REDACTED]');
    expect((parsed['nested'] as Record<string, unknown>)['taxNumber']).toBe('[REDACTED]');
    expect(parsed['dsn']).toBe('postgres://forge:[REDACTED]@10.0.0.5:5432/forge_db');
    expect((parsed['cyclic'] as Record<string, unknown>)['self']).toBe('[Circular]');
    expect((parsed['err'] as Record<string, unknown>)['stack']).toBeUndefined();
    expect(String((parsed['err'] as Record<string, unknown>)['message'])).toContain('[REDACTED]');

    // Opt-in includeStack for development
    const devSink = createMemoryLogSink();
    const devLogger = createPinoLogger({
      level: 'error',
      includeStack: true,
      destination: devSink.stream,
    });
    devLogger.error('dev failure', { err: new Error('boom') });
    const devEntry = devSink.entries()[0]!;
    expect(typeof (devEntry['err'] as Record<string, unknown>)['stack']).toBe('string');
  });

  it('fuzz-tests log sanitization against arbitrary secrets, CRLF injection, and deep nesting (100 runs)', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 8, maxLength: 32 }).filter((s) => /^[A-Za-z0-9_-]+$/.test(s)),
        fc.string({ minLength: 1, maxLength: 40 }),
        (secretToken, arbitraryMsg) => {
          const sanitizedMsg = sanitizeLogMessage(`${arbitraryMsg}\r\nINJECTED\0`);
          expect(sanitizedMsg).not.toMatch(/[\r\n\0]/);

          const sanitized = sanitizeLogContext({
            password: secretToken,
            nested: {
              wrapped: secret(secretToken),
              note: `Authorization: Bearer ${secretToken}`,
              url: `postgres://user:${secretToken}@db.example.com:5432/app`,
            },
          });

          const serialized = JSON.stringify(sanitized);
          expect(serialized).not.toContain(secretToken);
        },
      ),
      { numRuns: 100 },
    );
  });
});
