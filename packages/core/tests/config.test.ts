import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  ConfigurationError,
  createConfigManager,
  isSecretValue,
  secret,
} from '../src/index.js';

describe('@forge-fr/core — ConfigManager, SecretValue & Security Protections', () => {
  it('merges defaults and overrides deeply, enforces immutability, and resolves dot-paths', () => {
    const config = createConfigManager({
      defaults: {
        server: { host: '127.0.0.1', port: 3000 },
        features: { metrics: false },
      },
      values: {
        server: { port: 8080 },
      },
    });

    expect(config.get<string>('server.host')).toBe('127.0.0.1');
    expect(config.get<number>('server.port')).toBe(8080);
    expect(config.get<boolean>('features.metrics')).toBe(false);
    expect(config.has('server.port')).toBe(true);
    expect(config.has('server.missing')).toBe(false);
    expect(config.getOrThrow<number>('server.port')).toBe(8080);
    expect(() => config.getOrThrow('server.missing')).toThrow(ConfigurationError);

    const snapshot = config.toObject() as { server: { port: number } };
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.server)).toBe(true);
  });

  it('validates configuration at creation time and fails fast with ConfigurationError', () => {
    interface AppConfig {
      port: number;
      env: 'development' | 'production';
    }

    expect(() =>
      createConfigManager<AppConfig>({
        values: { port: -1, env: 'production' },
        validate: (raw) => {
          const obj = raw as Partial<AppConfig>;
          if (typeof obj.port !== 'number' || obj.port < 1 || obj.port > 65535) {
            throw new Error('port must be between 1 and 65535');
          }
          return obj as AppConfig;
        },
      }),
    ).toThrow(ConfigurationError);

    const valid = createConfigManager<AppConfig>({
      values: { port: 3000, env: 'production' },
      validate: (raw) => raw as AppConfig,
    });
    expect(valid.toObject().port).toBe(3000);
  });

  it('SECURITY: masks SecretValue in toString, JSON.stringify, and toSafeObject while supporting explicit reveal()', () => {
    const dbPassword = secret('s3cr3t-db-pass!');
    expect(isSecretValue(dbPassword)).toBe(true);
    expect(String(dbPassword)).toBe('[REDACTED]');
    expect(JSON.stringify({ pwd: dbPassword })).toBe('{"pwd":"[REDACTED]"}');
    expect(dbPassword.reveal()).toBe('s3cr3t-db-pass!');

    const config = createConfigManager({
      values: {
        db: {
          host: 'localhost',
          password: dbPassword,
        },
      },
    });

    const safe = config.toSafeObject();
    expect(safe).toEqual({
      db: {
        host: 'localhost',
        password: '[REDACTED]',
      },
    });
    expect(JSON.stringify(safe)).not.toContain('s3cr3t-db-pass!');
  });

  it('SECURITY: rejects prototype pollution payloads (__proto__, constructor, prototype)', () => {
    const maliciousJson = JSON.parse('{"__proto__":{"polluted":true}}') as Record<string, unknown>;
    expect(() => createConfigManager({ values: maliciousJson })).toThrow(ConfigurationError);

    expect(() =>
      createConfigManager({
        values: { nested: { constructor: { prototype: { admin: true } } } },
      }),
    ).toThrow(ConfigurationError);

    expect(() =>
      createConfigManager({
        values: { prototype: { hacked: true } },
      }),
    ).toThrow(ConfigurationError);

    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(({} as Record<string, unknown>).admin).toBeUndefined();
  });

  it('SECURITY (property-based): rejects dangerous keys anywhere in arbitrary nested config objects', () => {
    const forbiddenKeyArb = fc.constantFrom('__proto__', 'constructor', 'prototype');
    const safeKeyArb = fc.stringMatching(/^[a-z][a-z0-9_]{0,8}$/).filter(
      (k) => k !== '__proto__' && k !== 'constructor' && k !== 'prototype',
    );

    fc.assert(
      fc.property(safeKeyArb, forbiddenKeyArb, fc.string(), (outerKey, badKey, val) => {
        const inner = Object.create(null) as Record<string, unknown>;
        Object.defineProperty(inner, badKey, {
          value: val,
          enumerable: true,
          configurable: true,
        });
        const payload: Record<string, unknown> = { [outerKey]: inner };
        expect(() => createConfigManager({ values: payload })).toThrow(ConfigurationError);
      }),
      { numRuns: 50 },
    );
  });
});
