import { attachProcessShutdown, createNodeAdapter } from '@forge-fr/node';
import { createPlaygroundBackend } from './app.ts';

const PORT = Number(process.env['PORT'] ?? 3000);
const HOST = '0.0.0.0';

async function main(): Promise<void> {
  const backend = createPlaygroundBackend({
    adapter: createNodeAdapter({ trustHostHeader: true }),
  });

  await backend.start();
  const address = await backend.app.listen({ host: HOST, port: PORT });
  console.log(`Modular ForgeJS example running on ${address.url}`);

  attachProcessShutdown(backend.app, {
    exitOnComplete: true,
    onShutdown: async () => {
      await backend.close();
    },
  });
}

void main();
