import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as v from 'valibot';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { z } from 'zod';
import { createKernel } from '@forge-fr/core';
import {
  ConfigTokens,
  ConfigValidationError,
  createConfigLoader,
  createConfigPlugin,
  createConfigToken,
  defineConfig,
  isSecretConfigKey,
  loadConfig,
  parseDotEnv,
  redactConfig,
} from '../src/index.js';
import { loadDotEnvFiles, loadDotEnvFilesSync, loadNodeConfig } from '../src/node.js';

describe('Part 6 — @forge-fr/config Typed Configuration & Environment Validation', () => {
  it('validates synchronously with Zod v4, infers strict readonly types, and deep-freezes output', () => {
    const EnvSchema = z.object({
      PORT: z.coerce.number().int().positive().default(3000),
      NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
      DATABASE_URL: z.string().url(),
      JWT_SECRET: z.string().min(32),
      FEATURE_FLAGS: z
        .string()
        .default('a,b')
        .transform((raw) => raw.split(',')),
    });

    const config = defineConfig({
      schema: EnvSchema,
      env: {
        PORT: '8080',
        NODE_ENV: 'production',
        DATABASE_URL: 'postgresql://user:pass@localhost:5432/app',
        JWT_SECRET: 'super-secret-signing-key-with-at-least-32-chars',
      },
    });

    expectTypeOf(config.PORT).toEqualTypeOf<number>();
    expectTypeOf(config.NODE_ENV).toEqualTypeOf<'development' | 'test' | 'production'>();
    expectTypeOf(config.DATABASE_URL).toEqualTypeOf<string>();
    expectTypeOf(config.FEATURE_FLAGS).toEqualTypeOf<string[]>();

    expect(config.PORT).toBe(8080);
    expect(config.NODE_ENV).toBe('production');
    expect(config.FEATURE_FLAGS).toEqual(['a', 'b']);
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.FEATURE_FLAGS)).toBe(true);
  });

  it('validates with Valibot v1 via Standard Schema v1 without extra adapters', () => {
    const ValibotSchema = v.object({
      HOST: v.optional(v.string(), '127.0.0.1'),
      WORKERS: v.pipe(v.string(), v.transform(Number), v.integer(), v.minValue(1)),
    });

    const config = defineConfig({
      schema: ValibotSchema,
      env: { WORKERS: '4' },
    });

    expectTypeOf(config.HOST).toEqualTypeOf<string>();
    expectTypeOf(config.WORKERS).toEqualTypeOf<number>();
    expect(config).toEqual({ HOST: '127.0.0.1', WORKERS: 4 });
  });

  it('supports prefix stripping and precedence (defaults < dotenvContent < env)', () => {
    const Schema = z.object({
      PORT: z.coerce.number(),
      HOST: z.string(),
      MODE: z.string(),
    });

    const config = defineConfig({
      schema: Schema,
      prefix: 'FORGE_',
      defaults: { PORT: 3000, HOST: '0.0.0.0', MODE: 'default' },
      dotenvContent: 'FORGE_PORT=4000\nFORGE_MODE=dotenv\nUNRELATED=ignored',
      env: { FORGE_PORT: '5000', OTHER_KEY: 'skip' },
    });

    expect(config).toEqual({ PORT: 5000, HOST: '0.0.0.0', MODE: 'dotenv' });
  });

  it('parses .env syntax (export, quotes, multiline, inline comments, ${VAR:-default} expansion, proto-key blocking)', () => {
    const parsed = parseDotEnv(
      [
        '# leading comment',
        'export APP_NAME="ForgeJS App" # inline comment',
        "SINGLE_QUOTED='literal $APP_NAME # not a comment'",
        'MULTILINE="line1\\nline2"',
        'BACKTICK=`lineA\nlineB`',
        'EXPANDED="${APP_NAME} (${MISSING:-fallback})"',
        '__proto__=polluted',
        'constructor=bad',
        'prototype=bad',
      ].join('\n'),
      { expand: true },
    );

    expect(parsed['APP_NAME']).toBe('ForgeJS App');
    expect(parsed['SINGLE_QUOTED']).toBe('literal $APP_NAME # not a comment');
    expect(parsed['MULTILINE']).toBe('line1\nline2');
    expect(parsed['BACKTICK']).toBe('lineA\nlineB');
    expect(parsed['EXPANDED']).toBe('ForgeJS App (fallback)');
    expect(Object.prototype.hasOwnProperty.call(parsed, '__proto__')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(parsed, 'constructor')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(parsed, 'prototype')).toBe(false);
  });

  it('never leaks secret values in ConfigValidationError messages or redactConfig()', () => {
    const SecretSchema = z.object({
      PORT: z.coerce.number().int(),
      JWT_SECRET: z.string().min(32),
      DATABASE_URL: z.string().url(),
      CUSTOM_API_CRED: z.string().min(10),
    });

    const secretInput = 'too-short-secret-value-123';
    const dbCred = 'postgresql://admin:UltraSecretPass99@db.internal:5432/prod';

    let thrown: unknown;
    try {
      defineConfig({
        schema: SecretSchema,
        secrets: ['CUSTOM_API_CRED'],
        env: {
          PORT: 'abc',
          JWT_SECRET: secretInput,
          DATABASE_URL: 'not-a-url-' + dbCred,
          CUSTOM_API_CRED: 'tiny',
        },
      });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(ConfigValidationError);
    const err = thrown as ConfigValidationError;
    expect(err.code).toBe('CONFIGURATION_ERROR');
    expect(err.expose).toBe(false);
    expect(err.message).not.toContain(secretInput);
    expect(err.message).not.toContain('UltraSecretPass99');
    expect(err.issues.find((i) => i.path === 'JWT_SECRET')?.isSecret).toBe(true);
    expect(err.issues.find((i) => i.path === 'CUSTOM_API_CRED')?.isSecret).toBe(true);

    expect(isSecretConfigKey('STRIPE_API_KEY')).toBe(true);
    expect(isSecretConfigKey('PUBLIC_PORT')).toBe(false);

    const redacted = redactConfig(
      {
        PORT: 3000,
        JWT_SECRET: 'top-secret',
        DATABASE_URL: 'postgresql://user:pass@localhost/db',
        nested: { apiToken: 'tok_live_123', region: 'us-east-1' },
      },
      { secrets: ['customField'] },
    );
    expect(redacted).toEqual({
      PORT: 3000,
      JWT_SECRET: '[REDACTED]',
      DATABASE_URL: '[REDACTED]',
      nested: { apiToken: '[REDACTED]', region: 'us-east-1' },
    });
  });

  it('supports async schemas, custom fileReader, and Edge WeakMap-cached createConfigLoader()', async () => {
    const AsyncSchema = z.object({
      PORT: z.coerce.number(),
      REGION: z.string().refine(async (val) => val.length > 0, 'Empty region'),
    });

    const loaded = await loadConfig({
      schema: AsyncSchema,
      dotenvFiles: ['.env', '.env.local'],
      fileReader: async (filePath) => {
        if (filePath === '.env') return 'PORT=3000\nREGION=eu-west';
        if (filePath === '.env.local') return 'PORT=4000';
        return undefined;
      },
      env: {},
    });
    expect(loaded).toEqual({ PORT: 4000, REGION: 'eu-west' });

    const EdgeSchema = z.object({
      API_URL: z.string().url(),
      TENANT: z.string(),
    });
    const loader = createConfigLoader({ schema: EdgeSchema });

    const workerEnvA = { API_URL: 'https://a.example.com', TENANT: 'alpha' };
    const workerEnvB = { API_URL: 'https://b.example.com', TENANT: 'beta' };

    const first = loader.parse(workerEnvA);
    const second = loader.parse(workerEnvA);
    const other = loader.parse(workerEnvB);

    expect(first).toBe(second); // WeakMap cache hit
    expect(other).not.toBe(first);
    expect(other.TENANT).toBe('beta');
  });

  it('integrates cleanly as a ForgeJS DI plugin with typed token & secret-safe health check', async () => {
    const AppSchema = z.object({
      PORT: z.coerce.number().default(3000),
      SERVICE_NAME: z.string().default('billing'),
      JWT_SECRET: z.string().min(16),
    });
    type AppConfig = z.infer<typeof AppSchema>;
    const AppConfigToken = createConfigToken<AppConfig>('BillingConfig');

    const kernel = createKernel({
      plugins: [
        createConfigPlugin({
          schema: AppSchema,
          token: AppConfigToken,
          env: { PORT: '4200', JWT_SECRET: '0123456789abcdef-secret' },
        }),
      ],
    });

    await kernel.start();
    const cfg = kernel.container.resolve(AppConfigToken);
    const rawCfg = kernel.container.resolve(ConfigTokens.Config);

    expectTypeOf(cfg).toEqualTypeOf<Readonly<AppConfig>>();
    expect(cfg.PORT).toBe(4200);
    expect(cfg.SERVICE_NAME).toBe('billing');
    expect(rawCfg).toBe(cfg);

    const health = await kernel.health.runAll();
    expect(health.status).toBe('ok');
    const serializedHealth = JSON.stringify(health);
    expect(serializedHealth).toContain('config:validated');
    expect(serializedHealth).not.toContain('0123456789abcdef-secret');

    await kernel.dispose();
  });

  it('loads layered .env files via @forge-fr/config/node (sync & async) with process env taking precedence', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-config-test-'));
    try {
      await fs.writeFile(path.join(tmpDir, '.env'), 'PORT=3000\nHOST=127.0.0.1\nMODE=base\n');
      await fs.writeFile(path.join(tmpDir, '.env.local'), 'PORT=3001\n');
      await fs.writeFile(path.join(tmpDir, '.env.test'), 'MODE=testing\n');
      await fs.writeFile(path.join(tmpDir, '.env.test.local'), 'EXTRA=local-test\n');

      const syncEnv = loadDotEnvFilesSync({
        cwd: tmpDir,
        nodeEnv: 'test',
        baseEnv: { HOST: '10.0.0.1' },
      });
      expect(syncEnv).toMatchObject({
        PORT: '3001',
        HOST: '10.0.0.1', // baseEnv wins over .env
        MODE: 'testing',
        EXTRA: 'local-test',
      });

      const asyncEnv = await loadDotEnvFiles({
        cwd: tmpDir,
        nodeEnv: 'test',
        baseEnv: { HOST: '10.0.0.2' },
      });
      expect(asyncEnv['HOST']).toBe('10.0.0.2');
      expect(asyncEnv['PORT']).toBe('3001');

      const Schema = z.object({
        PORT: z.coerce.number(),
        HOST: z.string(),
        MODE: z.string(),
        EXTRA: z.string(),
      });

      const nodeCfg = await loadNodeConfig({
        schema: Schema,
        env: { HOST: '0.0.0.0' },
        dotenv: { cwd: tmpDir, nodeEnv: 'test' },
      });
      expect(nodeCfg).toEqual({
        PORT: 3001,
        HOST: '0.0.0.0',
        MODE: 'testing',
        EXTRA: 'local-test',
      });
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('keeps root @forge-fr/config source completely free of node:* imports for Edge portability', async () => {
    const srcDir = path.resolve(import.meta.dirname, '../src');
    const files = (await fs.readdir(srcDir)).filter((f) => f.endsWith('.ts') && f !== 'node.ts');
    for (const file of files) {
      const code = await fs.readFile(path.join(srcDir, file), 'utf8');
      expect(code, `Unexpected node:* import in ${file}`).not.toMatch(/['"]node:/);
    }
  });
});
