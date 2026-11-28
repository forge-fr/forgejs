import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  createToken,
  defineModule,
  definePlugin,
} from '@forge-fr/core';
import { createSseResponse, readBoundedMultipart, readBoundedUrlEncoded } from '@forge-fr/http';
import {
  createTestApp,
  createTestKernel,
  overrideFactory,
  overrideValue,
} from '../src/index.js';

interface MailerService {
  send(to: string, subject: string): Promise<string>;
}

const MailerToken = createToken<MailerService>('Mailer');
const ApiBaseUrlToken = createToken<string>('ApiBaseUrl');
const GreetingToken = createToken<string>('Greeting');

describe('Part 12 — First-Class Testing Harness (createTestKernel, createTestApp & TestClient)', () => {
  it('boots createTestKernel with typed overrides over both module and plugin providers plus Symbol.asyncDispose', async () => {
    const sent: string[] = [];

    const MailerPlugin = definePlugin({
      name: 'test-mailer-plugin',
      version: '1.0.0',
      forgeVersion: '^1.0.0-rc.1',
      capabilities: ['di:register'],
      register(ctx) {
        ctx.registerProvider(
          {
            token: MailerToken,
            useValue: {
              async send() {
                throw new Error('Real SMTP must not run in unit tests');
              },
            },
          },
          { export: true },
        );
      },
    });

    const CoreModule = defineModule({
      name: 'core-module',
      providers: [
        { token: ApiBaseUrlToken, useValue: 'https://prod.example.com' },
        {
          token: GreetingToken,
          useFactory: (resolver) => `Hello from ${resolver.resolve(ApiBaseUrlToken)}`,
        },
      ],
      exports: [ApiBaseUrlToken, GreetingToken],
    });

    // Compile-time type check for overrideValue / overrideFactory
    // @ts-expect-error — number is not assignable to InjectionToken<string>
    const _invalidOverride = () => overrideValue(ApiBaseUrlToken, 12345);
    void _invalidOverride;

    let kernelRef: { readonly state: string } | undefined;
    {
      await using testKernel = await createTestKernel({
        modules: [CoreModule],
        plugins: [MailerPlugin],
        overrides: [
          overrideValue(ApiBaseUrlToken, 'https://test.local'),
          overrideValue(MailerToken, {
            async send(to, subject) {
              sent.push(`${to}:${subject}`);
              return 'mock-msg-id';
            },
          }),
          overrideFactory(GreetingToken, (r) => `Mocked:${r.resolve(ApiBaseUrlToken)}`),
        ],
      });

      const mailer = testKernel.resolve(MailerToken);
      const greeting = testKernel.resolve(GreetingToken);

      expectTypeOf(mailer).toEqualTypeOf<MailerService>();
      expectTypeOf(greeting).toEqualTypeOf<string>();

      expect(await mailer.send('ada@example.com', 'Welcome')).toBe('mock-msg-id');
      expect(sent).toEqual(['ada@example.com:Welcome']);
      expect(greeting).toBe('Mocked:https://test.local');

      kernelRef = testKernel.kernel;
      expect(kernelRef.state).not.toBe('disposed');
    }

    expect(kernelRef?.state).toBe('disposed');
  });

  it('boots createTestApp with cookieJar persistence/expiry, multipart uploads, form bodies, and SSE parsing', async () => {
    await using testApp = await createTestApp({
      client: { cookieJar: true },
      overrides: [overrideValue(ApiBaseUrlToken, 'https://sandbox.test')],
      setup(app) {
        app.post('/login', (ctx) =>
          ctx.json(
            { loggedIn: true, api: app.kernel.container.resolve(ApiBaseUrlToken) },
            {
              headers: {
                'set-cookie': 'sid=session_abc; Path=/; HttpOnly',
              },
            },
          ),
        );

        app.get('/session', (ctx) =>
          ctx.json({ cookieHeader: ctx.header('cookie') }),
        );

        app.post('/logout', (ctx) =>
          ctx.json(
            { loggedOut: true },
            {
              headers: {
                'set-cookie': 'sid=; Max-Age=0; Path=/',
              },
            },
          ),
        );

        app.post('/form', async (ctx) => {
          const parsed = await readBoundedUrlEncoded(ctx.request);
          return ctx.json({ fields: parsed });
        });

        app.post('/upload', async (ctx) => {
          const parsed = await readBoundedMultipart(ctx.request);
          const files = await Promise.all(
            parsed.files.map(async (f) => ({
              field: f.fieldName,
              filename: f.name,
              contentType: f.type,
              text: await f.text(),
            })),
          );
          return ctx.json({
            title: parsed.fields['title'],
            files,
          });
        });

        app.get('/events', (ctx) =>
          createSseResponse(
            (stream) => {
              stream.comment('heartbeat');
              stream.send({ id: '1', event: 'order.created', data: { id: 'o_1', total: 42 } });
              stream.send({ id: '2', data: 'plain-text-update', retry: 2500 });
              stream.close();
            },
            { signal: ctx.signal },
          ),
        );
      },
    });

    // 1. Cookie jar capture + automatic forwarding + Max-Age=0 expiry
    const loginRes = await testApp.post('/login');
    expect(loginRes.status).toBe(200);
    expect(await loginRes.json()).toEqual({ loggedIn: true, api: 'https://sandbox.test' });
    expect(testApp.cookies()).toEqual({ sid: 'session_abc' });

    const sessionRes = await testApp.get('/session');
    expect(await sessionRes.json()).toEqual({ cookieHeader: 'sid=session_abc' });

    await testApp.post('/logout');
    expect(testApp.cookies()).toEqual({});

    // 2. URL-encoded form submission
    const formRes = await testApp.post('/form', {
      form: { email: 'ada@example.com', plan: 'pro' },
    });
    expect(formRes.status).toBe(200);
    expect(await formRes.json()).toEqual({
      fields: { email: 'ada@example.com', plan: 'pro' },
    });

    // 3. Multipart file + field upload
    const uploadRes = await testApp.post('/upload', {
      multipart: {
        title: 'Invoice Q4',
        attachment: {
          filename: 'invoice.txt',
          content: 'Amount: $42',
          contentType: 'text/plain',
        },
      },
    });
    expect(uploadRes.status).toBe(200);
    expect(await uploadRes.json()).toEqual({
      title: 'Invoice Q4',
      files: [
        {
          field: 'attachment',
          filename: 'invoice.txt',
          contentType: 'text/plain',
          text: 'Amount: $42',
        },
      ],
    });

    // 4. Structured SSE response parsing
    const sseRes = await testApp.sse('/events');
    expect(sseRes.status).toBe(200);
    expect(sseRes.comments).toEqual(['heartbeat']);
    expect(sseRes.events).toHaveLength(2);
    expect(sseRes.events[0]?.id).toBe('1');
    expect(sseRes.events[0]?.event).toBe('order.created');
    expect(sseRes.events[0]?.json()).toEqual({ id: 'o_1', total: 42 });
    expect(sseRes.events[1]?.id).toBe('2');
    expect(sseRes.events[1]?.event).toBe('message');
    expect(sseRes.events[1]?.data).toBe('plain-text-update');
    expect(sseRes.events[1]?.retry).toBe(2500);
  });
});
