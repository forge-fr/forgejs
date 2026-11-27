import { attachProcessShutdown, createNodeAdapter } from '@forge-fr/node';
import { createPlaygroundBackend } from './server/app.ts';

const PORT = Number(process.env['PORT'] ?? 3000);
const HOST = '0.0.0.0';

async function startServer(): Promise<void> {
  const backend = createPlaygroundBackend({
    adapter: createNodeAdapter({ trustHostHeader: true }),
  });

  backend.app.get('/', (ctx) =>
    ctx.json({
      service: 'forgejs-playground-backend',
      runtime: 'node',
      docs: '/playground-api/docs',
      openapi: '/playground-api/openapi.json',
      health: {
        live: '/playground-api/health/live',
        ready: '/playground-api/health/ready',
      },
    }),
  );

  await backend.start();
  const address = await backend.app.listen({ host: HOST, port: PORT });
  console.log(`ForgeJS Playground Backend running on ${address.url} (Swagger UI: ${address.url}/playground-api/docs)`);

  attachProcessShutdown(backend.app, {
    exitOnComplete: true,
    onShutdown: async () => {
      await backend.close();
    },
  });
}

void startServer();
