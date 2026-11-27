import { createHttpApp } from '@forge-fr/http';
import { attachProcessShutdown, createNodeAdapter } from '@forge-fr/node';
import { validatedHandler } from '@forge-fr/validation';
import { z } from 'zod';

const app = createHttpApp();

app.get('/health', (ctx) => ctx.json({ ok: true, framework: 'forgejs' }));

app.post(
  '/users',
  validatedHandler(
    {
      body: z.object({
        email: z.string().email(),
        role: z.enum(['member', 'admin']).default('member'),
      }),
    },
    (ctx, input) => ctx.json({ created: true, user: input.body }, { status: 201 }),
  ),
);

const server = await app.listen({
  adapter: createNodeAdapter({ trustHostHeader: true }),
  host: '0.0.0.0',
  port: Number(process.env['PORT'] ?? 3000),
});

console.log(`Listening on ${server.url}`);
attachProcessShutdown(app, { exitOnComplete: true });
