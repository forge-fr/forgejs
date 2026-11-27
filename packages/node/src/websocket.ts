import { createHash, randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import type {
  FetchHandler,
  RegisteredWebSocketRoute,
  WebSocketConnection,
  WebSocketMessageData,
  WebSocketUpgradeContext,
} from '@forge-fr/http';

const WS_MAGIC_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function buildHeaderLookup(req: IncomingMessage): Headers {
  const headers = new Headers();
  const raw = req.rawHeaders;
  for (let i = 0; i < raw.length; i += 2) {
    const name = raw[i];
    const value = raw[i + 1];
    if (name !== undefined && value !== undefined) {
      headers.append(name, value);
    }
  }
  return headers;
}

function encodeWsFrame(opcode: number, payload: Uint8Array): Buffer {
  const len = payload.byteLength;
  let header: Buffer;
  if (len <= 125) {
    header = Buffer.allocUnsafe(2);
    header[0] = 0x80 | (opcode & 0x0f);
    header[1] = len;
  } else if (len <= 65535) {
    header = Buffer.allocUnsafe(4);
    header[0] = 0x80 | (opcode & 0x0f);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.allocUnsafe(10);
    header[0] = 0x80 | (opcode & 0x0f);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

function encodeClosePayload(code: number, reason: string): Uint8Array {
  const reasonBytes = new TextEncoder().encode(reason);
  const buf = new Uint8Array(2 + reasonBytes.byteLength);
  buf[0] = (code >> 8) & 0xff;
  buf[1] = code & 0xff;
  buf.set(reasonBytes, 2);
  return buf;
}

async function writeHttpRejection(socket: Duplex, response: Response): Promise<void> {
  if (socket.destroyed || !socket.writable) {
    return;
  }
  const body = await response.text().catch(() => '');
  const statusText = response.statusText || 'Rejected';
  const lines = [
    `HTTP/1.1 ${response.status} ${statusText}`,
    'Connection: close',
    `Content-Type: ${response.headers.get('content-type') ?? 'application/json; charset=utf-8'}`,
    `Content-Length: ${Buffer.byteLength(body, 'utf8')}`,
    '',
    body,
  ];
  socket.end(lines.join('\r\n'));
}

export async function handleNodeWebSocketUpgrade(options: {
  readonly req: IncomingMessage;
  readonly socket: Duplex;
  readonly head: Buffer;
  readonly handler: FetchHandler;
  readonly bindHost: string;
  readonly port: number;
  readonly trustHostHeader: boolean;
  readonly activeSockets: Set<(code?: number, reason?: string) => void>;
}): Promise<void> {
  const { req, socket, head, handler, bindHost, port, trustHostHeader, activeSockets } = options;

  if (typeof handler.authorizeWebSocketUpgrade !== 'function') {
    socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    return;
  }

  const wsKey = req.headers['sec-websocket-key'];
  if (typeof wsKey !== 'string' || wsKey.trim().length === 0) {
    socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    return;
  }

  const rawHost =
    trustHostHeader && typeof req.headers.host === 'string' && /^[A-Za-z0-9.\-:\[\]]+$/.test(req.headers.host)
      ? req.headers.host
      : `${bindHost.includes(':') ? `[${bindHost}]` : bindHost}:${port}`;
  const rawPath = req.url && req.url.startsWith('/') ? req.url : `/${req.url ?? ''}`;
  const request = new Request(`http://${rawHost}${rawPath}`, {
    method: 'GET',
    headers: buildHeaderLookup(req),
  });

  const decision = await handler.authorizeWebSocketUpgrade(request, {
    runtime: 'node',
    ...(req.socket.remoteAddress !== undefined ? { remoteAddress: req.socket.remoteAddress } : {}),
  });

  if (!decision.accepted) {
    await writeHttpRejection(socket, decision.response);
    return;
  }

  const acceptKey = createHash('sha1').update(`${wsKey.trim()}${WS_MAGIC_GUID}`).digest('base64');
  const handshakeHeaders = [
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${acceptKey}`,
  ];
  if (decision.upgradeContext.protocol) {
    handshakeHeaders.push(`Sec-WebSocket-Protocol: ${decision.upgradeContext.protocol}`);
  }
  handshakeHeaders.push('', '');

  if ('setNoDelay' in socket && typeof socket.setNoDelay === 'function') {
    (socket as { setNoDelay(noDelay?: boolean): void }).setNoDelay(true);
  }
  socket.write(handshakeHeaders.join('\r\n'));

  attachRfc6455Session(socket, head, decision.route, decision.upgradeContext, activeSockets);
}

function attachRfc6455Session(
  socket: Duplex,
  initialHead: Buffer,
  route: RegisteredWebSocketRoute,
  upgradeContext: WebSocketUpgradeContext,
  activeSockets: Set<(code?: number, reason?: string) => void>,
): void {
  let state: 'open' | 'closing' | 'closed' = 'open';
  let closeNotified = false;
  let buffer: Buffer = initialHead.byteLength > 0 ? Buffer.from(initialHead) : Buffer.alloc(0);

  let fragmentOpcode: number | null = null;
  let fragmentChunks: Buffer[] = [];
  let fragmentSize = 0;

  const connState = upgradeContext.state;

  const finalizeClose = (code: number, reason: string, wasClean: boolean): void => {
    if (closeNotified) {
      return;
    }
    closeNotified = true;
    state = 'closed';
    activeSockets.delete(closeFn);
    if (!socket.destroyed) {
      socket.destroy();
    }
    void Promise.resolve(route.handlers.onClose?.(conn, { code, reason, wasClean })).catch(() => {});
  };

  const closeFn = (code = 1000, reason = ''): void => {
    if (state === 'closed' || state === 'closing') {
      return;
    }
    state = 'closing';
    try {
      if (!socket.destroyed && socket.writable) {
        socket.write(encodeWsFrame(0x8, encodeClosePayload(code, reason)));
        socket.end(() => {
          finalizeClose(code, reason, code === 1000);
        });
        const forceTimer = setTimeout(() => {
          finalizeClose(code, reason, code === 1000);
        }, 100);
        if (typeof forceTimer.unref === 'function') {
          forceTimer.unref();
        }
        return;
      }
    } catch {
      // Ignore write error on closing socket
    }
    finalizeClose(code, reason, code === 1000);
  };

  const conn: WebSocketConnection = {
    id: randomUUID(),
    url: upgradeContext.url,
    headers: upgradeContext.headers,
    params: upgradeContext.params,
    ...(upgradeContext.remoteAddress !== undefined
      ? { remoteAddress: upgradeContext.remoteAddress }
      : {}),
    protocol: upgradeContext.protocol,
    get readyState() {
      return state;
    },
    send(data: WebSocketMessageData): void {
      if (state !== 'open' || socket.destroyed || !socket.writable) {
        return;
      }
      if (typeof data === 'string') {
        socket.write(encodeWsFrame(0x1, new TextEncoder().encode(data)));
      } else {
        socket.write(encodeWsFrame(0x2, data));
      }
    },
    close: closeFn,
    ping(data?: WebSocketMessageData): void {
      if (state !== 'open' || socket.destroyed || !socket.writable) {
        return;
      }
      const bytes =
        data === undefined
          ? new Uint8Array(0)
          : typeof data === 'string'
            ? new TextEncoder().encode(data)
            : data;
      socket.write(encodeWsFrame(0x9, bytes));
    },
    getState<T = unknown>(key: string): T | undefined {
      return connState.get(key) as T | undefined;
    },
    setState<T = unknown>(key: string, value: T): void {
      connState.set(key, value);
    },
  };

  activeSockets.add(closeFn);

  const processBuffer = (): void => {
    while (state === 'open' && buffer.byteLength >= 2) {
      const b0 = buffer[0]!;
      const b1 = buffer[1]!;
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let payloadLen = b1 & 0x7f;
      let offset = 2;

      if (!masked) {
        closeFn(1002, 'Client frames must be masked');
        return;
      }

      if (payloadLen === 126) {
        if (buffer.byteLength < offset + 2) return;
        payloadLen = buffer.readUInt16BE(offset);
        offset += 2;
      } else if (payloadLen === 127) {
        if (buffer.byteLength < offset + 8) return;
        const len64 = buffer.readBigUInt64BE(offset);
        if (len64 > BigInt(Number.MAX_SAFE_INTEGER)) {
          closeFn(1009, 'Message Too Big');
          return;
        }
        payloadLen = Number(len64);
        offset += 8;
      }

      if (payloadLen > route.maxPayloadBytes || fragmentSize + payloadLen > route.maxPayloadBytes) {
        closeFn(1009, 'Message Too Big');
        return;
      }

      const maskLen = 4;
      const totalFrameLen = offset + maskLen + payloadLen;
      if (buffer.byteLength < totalFrameLen) {
        return;
      }

      const maskKey = buffer.subarray(offset, offset + 4);
      const maskedData = buffer.subarray(offset + 4, totalFrameLen);
      const unmasked = Buffer.allocUnsafe(payloadLen);
      for (let i = 0; i < payloadLen; i += 1) {
        unmasked[i] = maskedData[i]! ^ maskKey[i & 3]!;
      }

      buffer = buffer.subarray(totalFrameLen);

      if (opcode === 0x8) {
        // Close frame
        let code = 1000;
        let reason = '';
        if (unmasked.byteLength >= 2) {
          code = unmasked.readUInt16BE(0);
          reason = unmasked.subarray(2).toString('utf8');
        }
        closeFn(code, reason);
        return;
      }

      if (opcode === 0x9) {
        // Ping -> Pong
        if (!socket.destroyed && socket.writable) {
          socket.write(encodeWsFrame(0xA, unmasked));
        }
        continue;
      }

      if (opcode === 0xA) {
        void Promise.resolve(route.handlers.onPong?.(conn, new Uint8Array(unmasked))).catch(() => {});
        continue;
      }

      if (opcode === 0x1 || opcode === 0x2) {
        if (fin && fragmentOpcode === null) {
          const msg: WebSocketMessageData =
            opcode === 0x1 ? unmasked.toString('utf8') : new Uint8Array(unmasked);
          void Promise.resolve(route.handlers.onMessage?.(conn, msg)).catch((err: unknown) => {
            void route.handlers.onError?.(conn, err);
          });
        } else {
          fragmentOpcode = opcode;
          fragmentChunks = [unmasked];
          fragmentSize = unmasked.byteLength;
        }
        continue;
      }

      if (opcode === 0x0) {
        if (fragmentOpcode === null) {
          closeFn(1002, 'Unexpected continuation frame');
          return;
        }
        fragmentChunks.push(unmasked);
        fragmentSize += unmasked.byteLength;
        if (fin) {
          const assembled = Buffer.concat(fragmentChunks);
          const resolvedOp = fragmentOpcode;
          fragmentOpcode = null;
          fragmentChunks = [];
          fragmentSize = 0;
          const msg: WebSocketMessageData =
            resolvedOp === 0x1 ? assembled.toString('utf8') : new Uint8Array(assembled);
          void Promise.resolve(route.handlers.onMessage?.(conn, msg)).catch((err: unknown) => {
            void route.handlers.onError?.(conn, err);
          });
        }
        continue;
      }

      closeFn(1002, 'Unsupported opcode');
      return;
    }
  };

  socket.on('data', (chunk: Buffer) => {
    if (state !== 'open') return;
    buffer = buffer.byteLength === 0 ? chunk : Buffer.concat([buffer, chunk]);
    processBuffer();
  });

  socket.on('error', (err: Error) => {
    void Promise.resolve(route.handlers.onError?.(conn, err)).catch(() => {});
    finalizeClose(1006, 'Socket error', false);
  });

  socket.on('close', () => {
    finalizeClose(1000, '', true);
  });

  void Promise.resolve(route.handlers.onOpen?.(conn, upgradeContext))
    .then(() => {
      if (buffer.byteLength > 0) {
        processBuffer();
      }
    })
    .catch((err: unknown) => {
      void route.handlers.onError?.(conn, err);
      closeFn(1011, 'Internal server error');
    });
}
