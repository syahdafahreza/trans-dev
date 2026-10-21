import { Buffer } from 'buffer';
import TcpSocket from 'react-native-tcp-socket';
import RNFS from 'react-native-fs';

export interface HttpRequest {
  method: string;
  path: string;
  query: Record<string, string>;
  headers: Record<string, string>;
  body: Buffer;
}

export interface JsonResponse {
  status?: number;
  json: unknown;
}

export interface TextResponse {
  status?: number;
  text: string;
  contentType?: string;
}

/** A file that should be streamed from disk instead of buffered in memory. */
export interface FileResponse {
  filePath: string;
  mime: string;
  name: string;
  download?: boolean;
}

export type HandlerResult = JsonResponse | TextResponse | FileResponse;
export type Handler = (request: HttpRequest) => Promise<HandlerResult>;

/**
 * Minimal structural types for the native socket objects. `react-native-tcp-socket`
 * exports its classes through a default namespace, so importing them as named types
 * is brittle across versions; we only depend on the handful of methods we use.
 */
interface SocketLike {
  on(event: string, listener: (...args: never[]) => void): unknown;
  write(data: Buffer | string, encoding?: string, callback?: (error?: Error) => void): boolean;
  destroy(): void;
}

interface ServerLike {
  listen(options: { port: number; host?: string; reuseAddress?: boolean }, callback: () => void): unknown;
  on(event: string, listener: (...args: never[]) => void): unknown;
  close(callback?: () => void): unknown;
}

const MAX_BODY_BYTES = 32 * 1024 * 1024; // one 4 MB chunk, plus headroom
const STREAM_BLOCK = 256 * 1024;

function isFileResponse(result: HandlerResult): result is FileResponse {
  return typeof (result as FileResponse).filePath === 'string';
}

const CORS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'Authorization, Content-Type, X-Upload-Id, X-Upload-Offset, X-Upload-Size, X-Upload-Name, If-None-Match, Range',
  'Access-Control-Allow-Methods': 'GET, HEAD, POST, PUT, DELETE, OPTIONS',
};

function writeRaw(socket: SocketLike, data: Buffer | string): Promise<void> {
  return new Promise((resolve) => {
    try {
      // react-native-tcp-socket mirrors the Node signature: write(data, encoding?, cb?)
      socket.write(data, undefined, () => resolve());
      setTimeout(resolve, 40);
    } catch {
      resolve();
    }
  });
}

/**
 * A small HTTP/1.1 server that runs inside the app process.
 *
 * React Native has no Node `http` module, so this bridges `react-native-tcp-socket`
 * to a request/response API that mirrors the Node host in `apps/host`. Bodies are
 * capped per request and downloads are streamed in 256 KB blocks so a phone never
 * has to hold a whole video in memory.
 */
export class LocalHttpServer {
  private server: ServerLike | null = null;
  private active = new Set<SocketLike>();
  private handler: Handler;
  private port: number;
  private onConnectionChange?: (count: number) => void;

  constructor(options: {
    port: number;
    handler: Handler;
    onConnectionChange?: (count: number) => void;
  }) {
    this.port = options.port;
    this.handler = options.handler;
    this.onConnectionChange = options.onConnectionChange;
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = TcpSocket.createServer((rawSocket) => {
        const socket = rawSocket as unknown as SocketLike;
        this.active.add(socket);
        this.onConnectionChange?.(this.active.size);

        let buffer: Buffer = Buffer.alloc(0);
        let parsedHead = false;
        let headerEnd = 0;
        let contentLength = 0;
        let request: Omit<HttpRequest, 'body'> | null = null;
        let responded = false;

        const cleanup = () => {
          this.active.delete(socket);
          this.onConnectionChange?.(this.active.size);
          try {
            socket.destroy();
          } catch {
            /* already closed */
          }
        };

        socket.on('error', cleanup);
        socket.on('close', cleanup);

        const respond = async (result: HandlerResult) => {
          if (responded) return;
          responded = true;
          const head = request!;

          if (head.method === 'OPTIONS') {
            await writeRaw(socket, `HTTP/1.1 204 No Content\r\n${headerLines(CORS)}\r\n`);
            return;
          }

          try {
            if (isFileResponse(result)) {
              await this.sendFile(socket, head, result);
            } else if ('json' in result) {
              const payload = JSON.stringify(result.json);
              await writeRaw(
                socket,
                `HTTP/1.1 ${result.status ?? 200} ${statusText(result.status ?? 200)}\r\n` +
                  headerLines({
                    ...CORS,
                    'Content-Type': 'application/json; charset=utf-8',
                    'Content-Length': String(Buffer.byteLength(payload)),
                    'Cache-Control': 'no-store',
                  }) +
                  '\r\n' +
                  payload,
              );
            } else {
              const payload = result.text;
              await writeRaw(
                socket,
                `HTTP/1.1 ${result.status ?? 200} ${statusText(result.status ?? 200)}\r\n` +
                  headerLines({
                    ...CORS,
                    'Content-Type': result.contentType ?? 'text/plain; charset=utf-8',
                    'Content-Length': String(Buffer.byteLength(payload)),
                  }) +
                  '\r\n' +
                  payload,
              );
            }
          } catch (error) {
            const message = String(error instanceof Error ? error.message : error);
            await writeRaw(
              socket,
              `HTTP/1.1 500 Internal Server Error\r\n${headerLines({
                ...CORS,
                'Content-Type': 'application/json; charset=utf-8',
              })}\r\n${JSON.stringify({ error: { code: 'internal_error', message } })}`,
            );
          } finally {
            setTimeout(cleanup, 30);
          }
        };

        socket.on('data', async (...args: never[]) => {
          const chunk = args[0] as unknown;
          try {
            buffer = Buffer.concat([buffer, Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))]);

            if (!parsedHead) {
              headerEnd = buffer.indexOf('\r\n\r\n');
              if (headerEnd === -1) {
                if (buffer.length > 64 * 1024) cleanup();
                return;
              }
              const head = buffer.subarray(0, headerEnd).toString('utf8');
              const [requestLine, ...headerLinesRaw] = head.split('\r\n');
              const [method, target] = requestLine.split(' ');
              const headers: Record<string, string> = {};
              for (const line of headerLinesRaw) {
                const index = line.indexOf(':');
                if (index === -1) continue;
                headers[line.slice(0, index).trim().toLowerCase()] = line.slice(index + 1).trim();
              }
              const [rawPath, rawQuery = ''] = (target ?? '/').split('?');
              const query: Record<string, string> = {};
              for (const pair of rawQuery.split('&').filter(Boolean)) {
                const [key, value = ''] = pair.split('=');
                query[decodeURIComponent(key)] = decodeURIComponent(value.replace(/\+/g, ' '));
              }
              request = {
                method: (method ?? 'GET').toUpperCase(),
                path: decodeURIComponent(rawPath || '/'),
                query,
                headers,
              };
              contentLength = Number(headers['content-length'] ?? 0);
              if (contentLength > MAX_BODY_BYTES) {
                responded = true;
                await writeRaw(
                  socket,
                  `HTTP/1.1 413 Payload Too Large\r\n${headerLines({ ...CORS, 'Content-Type': 'application/json' })}\r\n` +
                    JSON.stringify({ error: { code: 'body_too_large', message: 'Send the file in smaller chunks' } }),
                );
                cleanup();
                return;
              }
              parsedHead = true;
            }

            const bodyStart = headerEnd + 4;
            const available = buffer.length - bodyStart;
            if (available < contentLength) return; // wait for the rest of the body

            const body = buffer.subarray(bodyStart, bodyStart + contentLength);
            const fullRequest: HttpRequest = { ...request!, body };
            const result = await this.handler(fullRequest);
            await respond(result);
          } catch (error) {
            console.warn('[trans-dev] request failed', error);
            cleanup();
          }
        });
      });

      const typedServer = server as unknown as ServerLike;
      typedServer.on('error', (...args: never[]) => {
        this.server = null;
        reject(args[0] instanceof Error ? args[0] : new Error('Could not open the socket'));
      });

      typedServer.listen({ port: this.port, host: '0.0.0.0' }, () => {
        this.server = typedServer;
        resolve();
      });
    });
  }

  /** Streams a file from disk, honouring a single Range header. */
  private async sendFile(socket: SocketLike, request: Omit<HttpRequest, 'body'>, file: FileResponse) {
    let size = 0;
    try {
      size = Number(await RNFS.stat(file.filePath).then((stat) => stat.size));
    } catch {
      await writeRaw(
        socket,
        `HTTP/1.1 404 Not Found\r\n${headerLines({ ...CORS, 'Content-Type': 'application/json' })}\r\n` +
          JSON.stringify({ error: { code: 'not_found', message: 'File not found' } }),
      );
      return;
    }

    const fallback = file.name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
    const disposition = `${file.download ? 'attachment' : 'inline'}; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(
      file.name,
    )}`;

    let start = 0;
    let end = size - 1;
    let status = 200;
    const range = request.headers.range;
    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (match && (match[1] || match[2])) {
        start = match[1] ? Number(match[1]) : Math.max(size - Number(match[2]), 0);
        end = match[2] && match[1] ? Math.min(Number(match[2]), size - 1) : size - 1;
        if (start > end || start >= size) {
          await writeRaw(
            socket,
            `HTTP/1.1 416 Range Not Satisfiable\r\n${headerLines({
              ...CORS,
              'Content-Range': `bytes */${size}`,
            })}\r\n`,
          );
          return;
        }
        status = 206;
      }
    }

    const length = Math.max(0, end - start + 1);
    const headers: Record<string, string> = {
      ...CORS,
      'Content-Type': file.mime,
      'Content-Length': String(length),
      'Accept-Ranges': 'bytes',
      'Content-Disposition': disposition,
      'Cache-Control': 'private, max-age=120',
    };
    if (status === 206) headers['Content-Range'] = `bytes ${start}-${end}/${size}`;

    await writeRaw(
      socket,
      `HTTP/1.1 ${status} ${statusText(status)}\r\n${headerLines(headers)}\r\n`,
    );
    if (request.method === 'HEAD') return;

    let position = start;
    while (position <= end) {
      const block = Math.min(STREAM_BLOCK, end - position + 1);
      const base64 = await RNFS.read(file.filePath, block, position, 'base64');
      if (!base64) break;
      const ok = socket.write(Buffer.from(base64, 'base64'));
      position += block;
      // Wait for the socket to drain when the OS buffer is full.
      if (!ok) await new Promise((resolve) => setTimeout(resolve, 8));
    }
  }

  stop(): Promise<void> {
    return new Promise((resolve) => {
      const server = this.server;
      this.server = null;
      for (const socket of this.active) {
        try {
          socket.destroy();
        } catch {
          /* ignore */
        }
      }
      this.active.clear();
      this.onConnectionChange?.(0);
      if (!server) return resolve();
      server.close(() => resolve());
      setTimeout(resolve, 500);
    });
  }

  get isRunning() {
    return this.server !== null;
  }
}

function headerLines(headers: Record<string, string>) {
  return `${Object.entries(headers)
    .map(([key, value]) => `${key}: ${value}`)
    .join('\r\n')}\r\n`;
}

function statusText(status: number) {
  const map: Record<number, string> = {
    200: 'OK',
    201: 'Created',
    204: 'No Content',
    206: 'Partial Content',
    400: 'Bad Request',
    401: 'Unauthorized',
    403: 'Forbidden',
    404: 'Not Found',
    409: 'Conflict',
    413: 'Payload Too Large',
    416: 'Range Not Satisfiable',
    429: 'Too Many Requests',
    500: 'Internal Server Error',
  };
  return map[status] ?? 'OK';
}
