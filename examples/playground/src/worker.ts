import {
  createCloudflareWorkerHandler,
  createEdgeAdapter,
  type CloudflareWorkerModule,
  type EdgeExecutionContextLike,
} from '@forge-fr/edge';
import { createWebCryptoPasswordHasher } from './cloudflare/webcrypto-password-hasher.ts';
import { createPlaygroundBackend } from './server/app.ts';

export interface WorkerEnv {
  readonly PLAYGROUND_JWT_SECRET?: string;
}

let workerHandlerPromise: Promise<CloudflareWorkerModule<WorkerEnv>> | null = null;

async function getHandler(env: WorkerEnv): Promise<CloudflareWorkerModule<WorkerEnv>> {
  if (workerHandlerPromise === null) {
    workerHandlerPromise = (async () => {
      const backend = createPlaygroundBackend({
        adapter: createEdgeAdapter(),
        passwordHasher: createWebCryptoPasswordHasher(),
        ...(env.PLAYGROUND_JWT_SECRET ? { jwtSecret: env.PLAYGROUND_JWT_SECRET } : {}),
      });

      backend.app.get('/', (ctx) =>
        ctx.json({
          service: 'forgejs-playground-backend',
          runtime: 'edge',
          docs: '/playground-api/docs',
          openapi: '/playground-api/openapi.json',
          health: {
            live: '/playground-api/health/live',
            ready: '/playground-api/health/ready',
          },
        }),
      );

      await backend.start();

      return createCloudflareWorkerHandler<WorkerEnv>(backend.app, {
        runtime: 'edge',
        autoStart: false,
        trustCfConnectingIp: true,
      });
    })().catch((err: unknown) => {
      workerHandlerPromise = null;
      throw err;
    });
  }

  return workerHandlerPromise;
}

const worker: CloudflareWorkerModule<WorkerEnv> = {
  async fetch(request: Request, env: WorkerEnv = {}, ctx?: EdgeExecutionContextLike): Promise<Response> {
    const handler = await getHandler(env);
    return handler.fetch(request, env, ctx);
  },
};

export default worker;
