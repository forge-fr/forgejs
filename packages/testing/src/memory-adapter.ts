import {
  ForgeHttpError,
  type FetchHandler,
  type HttpRuntimeAdapter,
  type ListenOptions,
  type RuntimeRequestMeta,
  type ServerAddress,
} from '@forge-fr/http';

export class MemoryAdapter implements HttpRuntimeAdapter {
  public readonly name = 'memory';
  public readonly runtime = 'memory' as const;

  private activeHandler: FetchHandler | null = null;
  private activeAddress: ServerAddress | null = null;

  public get isListening(): boolean {
    return this.activeHandler !== null;
  }

  public get address(): ServerAddress | null {
    return this.activeAddress;
  }

  public async listen(handler: FetchHandler, options: ListenOptions): Promise<ServerAddress> {
    if (this.activeHandler !== null) {
      throw new ForgeHttpError('MemoryAdapter is already listening', {
        code: 'ADAPTER_ALREADY_LISTENING',
        statusCode: 500,
        expose: false,
      });
    }

    const host = options.host ?? 'memory.forgejs.local';
    const port = options.port === 0 ? 80 : options.port;
    const url = `http://${host}:${port}`;

    this.activeHandler = handler;
    this.activeAddress = {
      host,
      port,
      protocol: 'http',
      url,
    };

    return this.activeAddress;
  }

  public async inject(
    request: Request,
    meta: Omit<RuntimeRequestMeta, 'runtime'> = {},
  ): Promise<Response> {
    if (this.activeHandler === null) {
      throw new ForgeHttpError('MemoryAdapter is not listening; call app.listen() first', {
        code: 'ADAPTER_NOT_LISTENING',
        statusCode: 500,
        expose: false,
      });
    }

    return this.activeHandler(request, {
      ...meta,
      runtime: 'memory',
    });
  }

  public async close(): Promise<void> {
    this.activeHandler = null;
    this.activeAddress = null;
  }
}
