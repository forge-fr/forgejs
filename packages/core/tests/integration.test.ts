import { describe, expect, it } from 'vitest';
import {
  KernelConfigToken,
  KernelLoggerToken,
  ProviderNotVisibleError,
  ValidationError,
  createConfigManager,
  createConsoleLogger,
  createContainer,
  createEventDispatcher,
  createHookRegistry,
  createKernel,
  createToken,
  defineModule,
  normalizeError,
  secret,
  type ConfigManager,
  type ForgeLogger,
  type LogEntry,
} from '../src/index.js';

describe('@forge-fr/core — Cross-Primitive Integration', () => {
  it('coordinates config, redacting logger, hook pipeline, events, and safe error serialization', async () => {
    const logs: LogEntry[] = [];
    const config = createConfigManager({
      defaults: {
        env: 'production',
        service: 'orders-api',
        apiKey: secret('sk_prod_top_secret'),
      },
    });

    const logger = createConsoleLogger({
      level: 'info',
      bindings: { service: config.get<string>('service') },
      sink: (entry) => logs.push(entry),
    });

    interface AppEvents {
      'request.failed': { requestId: string; code: string; statusCode: number };
    }
    const events = createEventDispatcher<AppEvents>();
    const observedEvents: Array<{ requestId: string; code: string; statusCode: number }> = [];
    events.on('request.failed', (payload) => {
      observedEvents.push(payload);
    });

    interface RequestHooks {
      preHandler: { requestId: string; headers: Record<string, string>; body: unknown };
    }
    const hooks = createHookRegistry<RequestHooks>();
    hooks.add(
      'preHandler',
      (ctx) => {
        logger.child({ requestId: ctx.requestId }).info('Handling request', {
          headers: ctx.headers,
          config: config.toSafeObject(),
        });
        if (!ctx.body) {
          throw new ValidationError('Request body is required');
        }
      },
      { id: 'audit-and-validate', priority: 1 },
    );

    let publicResponse: unknown;
    try {
      await hooks.runSequential('preHandler', {
        requestId: 'req-int-01',
        headers: { authorization: 'Bearer super-secret-jwt' },
        body: null,
      });
    } catch (caught: unknown) {
      const normalized = normalizeError(caught);
      await events.emit('request.failed', {
        requestId: 'req-int-01',
        code: normalized.code,
        statusCode: normalized.statusCode,
      });
      publicResponse = normalized.toPublicJSON({
        production: config.get<string>('env') === 'production',
        requestId: 'req-int-01',
      });
    }

    expect(publicResponse).toEqual({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Request body is required',
        requestId: 'req-int-01',
      },
    });
    expect(observedEvents).toEqual([
      { requestId: 'req-int-01', code: 'VALIDATION_ERROR', statusCode: 400 },
    ]);
    expect(logs).toHaveLength(1);
    const serializedLogs = JSON.stringify(logs);
    expect(serializedLogs).not.toContain('super-secret-jwt');
    expect(serializedLogs).not.toContain('sk_prod_top_secret');
  });

  it('wires singleton ConfigManager and ForgeLogger into request-scoped DI services with clean disposal', async () => {
    const ConfigToken = createToken<ConfigManager>('ConfigManager');
    const LoggerToken = createToken<ForgeLogger>('ForgeLogger');
    const RequestIdToken = createToken<string>('RequestId');
    const RequestLoggerToken = createToken<ForgeLogger>('RequestLogger');

    const logs: LogEntry[] = [];
    const disposed: string[] = [];

    const container = createContainer();
    container.register({
      token: ConfigToken,
      useFactory: () => createConfigManager({ defaults: { service: 'users-api' } }),
    });
    container.register({
      token: LoggerToken,
      useFactory: (di) =>
        createConsoleLogger({
          level: 'info',
          bindings: { service: di.resolve(ConfigToken).get<string>('service') },
          sink: (entry) => logs.push(entry),
        }),
      dispose: () => {
        disposed.push('root-logger');
      },
    });
    container.register({
      token: RequestLoggerToken,
      scope: 'request',
      useFactory: (di) => di.resolve(LoggerToken).child({ requestId: di.resolve(RequestIdToken) }),
      dispose: () => {
        disposed.push('req-logger');
      },
    });

    const reqScope = container.createScope();
    reqScope.register({ token: RequestIdToken, useValue: 'req-di-99' });
    reqScope.resolve(RequestLoggerToken).info('User lookup', { token: 'secret-should-redact' });

    await reqScope.dispose();
    await container.dispose();

    expect(logs).toHaveLength(1);
    expect(logs[0]?.context).toEqual({
      service: 'users-api',
      requestId: 'req-di-99',
      token: '[REDACTED]',
    });
    expect(disposed).toEqual(['req-logger', 'root-logger']);
  });

  it('boots a multi-module ApplicationKernel with encapsulated providers, redacted logs, and clean shutdown', async () => {
    const logs: LogEntry[] = [];
    const DbPoolToken = createToken<{ query(sql: string): string }>('DbPool');
    const UserServiceToken = createToken<{ findUser(id: string): string }>('UserService');
    const lifecycleTrace: string[] = [];

    const DatabaseModule = defineModule({
      name: 'database',
      providers: [
        {
          token: DbPoolToken,
          useFactory: (di) => {
            const cfg = di.resolve(KernelConfigToken);
            const logger = di.resolve(KernelLoggerToken);
            logger.info('Pool created', { password: cfg.get('dbPassword') });
            return { query: (sql: string) => `result(${sql})` };
          },
          dispose: () => {
            lifecycleTrace.push('dispose:db-pool');
          },
        },
      ],
      exports: [DbPoolToken],
      onShutdown: () => {
        lifecycleTrace.push('shutdown:database');
      },
    });

    const PrivateHashToken = createToken<string>('PrivateHash');
    const UserModule = defineModule({
      name: 'users',
      imports: [DatabaseModule],
      providers: [
        { token: PrivateHashToken, useValue: 'internal-salt' },
        {
          token: UserServiceToken,
          useFactory: (di) => {
            const pool = di.resolve(DbPoolToken);
            const salt = di.resolve(PrivateHashToken);
            return { findUser: (id: string) => `${pool.query(id)}#${salt.length}` };
          },
        },
      ],
      exports: [UserServiceToken],
      onShutdown: () => {
        lifecycleTrace.push('shutdown:users');
      },
    });

    const kernel = createKernel({
      config: { defaults: { dbPassword: secret('pg-secret-999') } },
      logger: createConsoleLogger({ level: 'info', sink: (e) => logs.push(e) }),
      modules: [UserModule],
    });

    await kernel.start();

    const userResolver = kernel.modules.getModuleResolver('users');
    expect(userResolver.resolve(UserServiceToken).findUser('u7')).toBe('result(u7)#13');
    expect(() => kernel.modules.getModuleResolver('database').resolve(PrivateHashToken)).toThrow(
      ProviderNotVisibleError,
    );

    await kernel.dispose();
    expect(lifecycleTrace).toEqual(['shutdown:users', 'shutdown:database', 'dispose:db-pool']);
    expect(JSON.stringify(logs)).not.toContain('pg-secret-999');
  });
});
