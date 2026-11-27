import { describe, expect, it } from 'vitest';
import { secret } from '@forge-fr/core';
import {
  DatabaseCheckViolationError,
  DatabaseConnectionError,
  DatabaseError,
  DatabaseForeignKeyViolationError,
  DatabaseNotNullViolationError,
  DatabaseSerializationError,
  DatabaseTimeoutError,
  DatabaseUniqueViolationError,
  normalizeDatabaseError,
  redactDatabaseUrl,
} from '../src/errors.js';
import {
  MigrationChecksumError,
  createMigrationCoordinator,
  type Migration,
  type MigrationStateStore,
} from '../src/migrations.js';

describe('@forge-fr/database Error Normalization & Security Redaction', () => {
  it('maps PostgreSQL SQLSTATE & network codes to typed non-exposed DatabaseError subclasses', () => {
    const unique = normalizeDatabaseError({
      code: '23505',
      constraint_name: 'users_email_key',
      table_name: 'users',
      column_name: 'email',
      message: 'duplicate key value violates unique constraint "users_email_key"',
    });
    expect(unique).toBeInstanceOf(DatabaseUniqueViolationError);
    expect(unique.code).toBe('DB_UNIQUE_VIOLATION');
    expect(unique.statusCode).toBe(409);
    expect(unique.expose).toBe(false);
    expect(unique.constraint).toBe('users_email_key');
    expect(unique.table).toBe('users');
    // Production public JSON MUST NOT leak constraint, table, or raw SQL error details
    const pub = unique.toPublicJSON({ production: true, requestId: 'req-1' });
    expect(pub.error.message).toBe('Internal Server Error');
    expect(pub.error.details).toBeUndefined();
    expect(JSON.stringify(pub)).not.toContain('users_email_key');

    const fk = normalizeDatabaseError({ code: '23503', constraint: 'orders_user_id_fkey' });
    expect(fk).toBeInstanceOf(DatabaseForeignKeyViolationError);
    expect(fk.code).toBe('DB_FOREIGN_KEY_VIOLATION');

    const notNull = normalizeDatabaseError({ code: '23502', column_name: 'email' });
    expect(notNull).toBeInstanceOf(DatabaseNotNullViolationError);
    expect(notNull.code).toBe('DB_NOT_NULL_VIOLATION');

    const check = normalizeDatabaseError({ code: '23514', constraint_name: 'age_positive' });
    expect(check).toBeInstanceOf(DatabaseCheckViolationError);
    expect(check.code).toBe('DB_CHECK_VIOLATION');

    const serial = normalizeDatabaseError({ code: '40001' });
    expect(serial).toBeInstanceOf(DatabaseSerializationError);
    expect(serial.retryable).toBe(true);

    const deadlock = normalizeDatabaseError({ code: '40P01' });
    expect(deadlock).toBeInstanceOf(DatabaseSerializationError);
    expect(deadlock.retryable).toBe(true);

    const timeout = normalizeDatabaseError({ code: '57014' });
    expect(timeout).toBeInstanceOf(DatabaseTimeoutError);
    expect(timeout.code).toBe('DB_TIMEOUT');

    const connTimeout = normalizeDatabaseError({ code: 'CONNECT_TIMEOUT' });
    expect(connTimeout).toBeInstanceOf(DatabaseTimeoutError);

    const connRefused = normalizeDatabaseError({ code: 'ECONNREFUSED', message: 'connect ECONNREFUSED' });
    expect(connRefused).toBeInstanceOf(DatabaseConnectionError);
    expect(connRefused.code).toBe('DB_CONNECTION_ERROR');

    const pgShutdown = normalizeDatabaseError({ code: '57P01' });
    expect(pgShutdown).toBeInstanceOf(DatabaseConnectionError);

    const fallback = normalizeDatabaseError(new Error('unexpected driver failure'));
    expect(fallback).toBeInstanceOf(DatabaseError);
    expect(fallback.code).toBe('DB_ERROR');
    expect(fallback.expose).toBe(false);
  });

  it('redacts passwords from PostgreSQL URLs and SecretValue instances', () => {
    expect(redactDatabaseUrl('postgres://admin:s3cr3tP@ss@db.internal:5432/app?sslmode=require')).toBe(
      'postgres://admin:[REDACTED]@db.internal:5432/app?sslmode=require',
    );
    expect(redactDatabaseUrl('postgresql://readonly@localhost:5432/app')).toBe(
      'postgresql://readonly@localhost:5432/app',
    );
    expect(redactDatabaseUrl(secret('postgres://user:top-secret@localhost:5432/db'))).toBe(
      'postgres://user:[REDACTED]@localhost:5432/db',
    );
    expect(redactDatabaseUrl('not-a-valid-url-with-secret')).toBe('[REDACTED_DATABASE_URL]');
  });
});

describe('@forge-fr/database Migration Coordinator & Lifecycle Hooks', () => {
  function createMemoryStore(): MigrationStateStore {
    const records: { id: string; name: string; checksum: string; appliedAt: string }[] = [];
    return {
      async listApplied() {
        return [...records];
      },
      async markApplied(record) {
        records.push(record);
      },
      async markRolledBack(id) {
        const idx = records.findIndex((r) => r.id === id);
        if (idx !== -1) records.splice(idx, 1);
      },
    };
  }

  it('runs pending migrations in deterministic order, executes hooks, detects checksum drift, and supports rollback', async () => {
    const log: string[] = [];
    const store = createMemoryStore();

    const m1: Migration<string> = {
      id: '001',
      name: 'create_users',
      checksum: 'sha256:aaa',
      up: async (client) => {
        log.push(`up:001:${client}`);
      },
      down: async (client) => {
        log.push(`down:001:${client}`);
      },
    };
    const m2: Migration<string> = {
      id: '002',
      name: 'add_sessions',
      checksum: 'sha256:bbb',
      up: async (client) => {
        log.push(`up:002:${client}`);
      },
      down: async (client) => {
        log.push(`down:002:${client}`);
      },
    };

    const coordinator = createMigrationCoordinator<string>({
      store,
      migrations: [m2, m1], // deliberately out of order to test sorting by id
      hooks: {
        beforeMigrate: (m) => {
          log.push(`before:${m.id}`);
        },
        afterMigrate: (m) => {
          log.push(`after:${m.id}`);
        },
        beforeRollback: (m) => {
          log.push(`before-rb:${m.id}`);
        },
        afterRollback: (m) => {
          log.push(`after-rb:${m.id}`);
        },
      },
    });

    const firstRun = await coordinator.migrate('pg-client');
    expect(firstRun.applied).toEqual(['001', '002']);
    expect(firstRun.skipped).toEqual([]);
    expect(log).toEqual([
      'before:001',
      'up:001:pg-client',
      'after:001',
      'before:002',
      'up:002:pg-client',
      'after:002',
    ]);

    // Second run skips both cleanly
    const secondRun = await coordinator.migrate('pg-client');
    expect(secondRun.applied).toEqual([]);
    expect(secondRun.skipped).toEqual(['001', '002']);

    // Rollback last migration
    const rolledBack = await coordinator.rollbackLast('pg-client');
    expect(rolledBack).toBe('002');
    expect(log.slice(-3)).toEqual(['before-rb:002', 'down:002:pg-client', 'after-rb:002']);

    // Tampered checksum on already-applied migration 001 fails fast
    const tampered = createMigrationCoordinator<string>({
      store,
      migrations: [{ ...m1, checksum: 'sha256:TAMPERED' }],
    });
    await expect(tampered.migrate('pg-client')).rejects.toThrow(MigrationChecksumError);
  });
});
