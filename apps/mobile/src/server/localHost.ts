import { Buffer } from 'buffer';
import RNFS from 'react-native-fs';
import { NetworkInfo } from 'react-native-network-info';

import { LocalHttpServer, type HandlerResult, type HttpRequest } from './httpServer';
import { PairingError, PairingService, type Session } from './pairing';

export interface SharedFolder {
  id: string;
  label: string;
  name: string;
}

export const SHARED_FOLDERS: SharedFolder[] = [
  { id: 'inbox', label: 'Inbox', name: 'Inbox' },
  { id: 'photos', label: 'Photos', name: 'Photos' },
  { id: 'documents', label: 'Documents', name: 'Documents' },
  { id: 'downloads', label: 'Downloads', name: 'Downloads' },
];

interface UploadRecord {
  id: string;
  tempPath: string;
  dir: string;
  name: string;
  size: number | null;
}

interface AssetGrant {
  path: string;
  sessionId: string;
  mode: 'inline' | 'download';
  expiresAt: number;
}

const KIND_BY_EXT: Record<string, string> = {
  jpg: 'image', jpeg: 'image', png: 'image', gif: 'image', webp: 'image', heic: 'image', svg: 'image',
  mp4: 'video', mov: 'video', m4v: 'video', webm: 'video', mkv: 'video',
  mp3: 'audio', m4a: 'audio', wav: 'audio', aac: 'audio', flac: 'audio',
  pdf: 'pdf', doc: 'document', docx: 'document', xls: 'spreadsheet', xlsx: 'spreadsheet',
  ppt: 'presentation', pptx: 'presentation', txt: 'text', md: 'text', csv: 'spreadsheet',
  json: 'code', js: 'code', ts: 'code', html: 'code', css: 'code',
  zip: 'archive', rar: 'archive', gz: 'archive', tar: 'archive',
};

const MIME_BY_EXT: Record<string, string> = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp',
  heic: 'image/heic', svg: 'image/svg+xml', mp4: 'video/mp4', mov: 'video/quicktime',
  webm: 'video/webm', mp3: 'audio/mpeg', m4a: 'audio/mp4', wav: 'audio/wav', pdf: 'application/pdf',
  txt: 'text/plain; charset=utf-8', json: 'application/json; charset=utf-8',
  md: 'text/markdown; charset=utf-8', csv: 'text/csv; charset=utf-8', zip: 'application/zip',
};

function extensionOf(name: string) {
  const index = name.lastIndexOf('.');
  return index > 0 ? name.slice(index + 1).toLowerCase() : '';
}

function kindOf(name: string) {
  return KIND_BY_EXT[extensionOf(name)] ?? 'file';
}

function mimeOf(name: string) {
  return MIME_BY_EXT[extensionOf(name)] ?? 'application/octet-stream';
}

interface DirItem {
  name: string;
  path: string;
  size: number;
  mtime?: Date | number;
  isDirectory(): boolean;
}

interface StatLike {
  size: number;
  mtime?: Date | number;
  isDirectory(): boolean;
}

/** Rejects `..` segments and keeps every request inside the shared folder. */
function normaliseVirtualPath(input: string): string {
  const raw = String(input ?? '/').replace(/\\/g, '/');
  const segments: string[] = [];
  for (const segment of raw.split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') throw new PairingError('Path traversal is not allowed', 400, 'invalid_path');
    segments.push(segment);
  }
  return `/${segments.join('/')}`;
}

export class LocalHost {
  readonly pairing: PairingService;
  readonly port: number;
  deviceName: string;
  root = `${RNFS.DocumentDirectoryPath}/TransDev`;
  private uploadsDir = `${RNFS.CachesDirectoryPath}/transdev-uploads`;
  private server: LocalHttpServer | null = null;
  private uploads = new Map<string, UploadRecord>();
  private assets = new Map<string, AssetGrant>();
  private connections = 0;
  private listeners = new Set<() => void>();
  private errorListeners = new Set<(error: Error) => void>();
  ip = '127.0.0.1';
  lastError: string | null = null;

  constructor(options: { port?: number; deviceName?: string; pin?: string } = {}) {
    this.port = options.port ?? 8787;
    this.deviceName = options.deviceName ?? 'My phone';
    this.pairing = new PairingService({ pin: options.pin });
  }

  onChange(listener: () => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  onError(listener: (error: Error) => void) {
    this.errorListeners.add(listener);
    return () => {
      this.errorListeners.delete(listener);
    };
  }

  private emit() {
    for (const listener of this.listeners) listener();
  }

  get isRunning() {
    return this.server !== null;
  }

  get connectionCount() {
    return this.connections;
  }

  get pairingUrl() {
    return `http://${this.ip}:${this.port}/?pin=${this.pairing.pin}`;
  }

  async start(): Promise<void> {
    await RNFS.mkdir(this.root);
    await Promise.all(SHARED_FOLDERS.map((folder) => RNFS.mkdir(`${this.root}/${folder.name}`.replace('//', '/'))));
    await RNFS.mkdir(this.uploadsDir);

    try {
      const address = await NetworkInfo.getIPAddress();
      if (address) this.ip = address;
    } catch {
      // Wi-Fi info is unavailable on some simulators; the URL will show 127.0.0.1.
    }

    const server = new LocalHttpServer({
      port: this.port,
      handler: (request) => this.handle(request),
      onConnectionChange: (count) => {
        this.connections = count;
        this.emit();
      },
    });

    try {
      await server.start();
      this.server = server;
      this.lastError = null;
      this.emit();
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      this.lastError = failure.message;
      for (const listener of this.errorListeners) listener(failure);
      this.emit();
      throw failure;
    }
  }

  async stop(): Promise<void> {
    await this.server?.stop();
    this.server = null;
    this.emit();
  }

  async toggle(): Promise<void> {
    if (this.isRunning) await this.stop();
    else await this.start();
  }

  // ------------------------------------------------------------------ routing

  private async handle(request: HttpRequest): Promise<HandlerResult> {
    const { method, path } = request;
    if (method === 'OPTIONS') return { text: '' };

    try {
      if (path === '/api/health') {
        return { json: { ok: true, deviceName: this.deviceName, uptimeMs: Date.now() } };
      }

      if (path === '/api/pair/info' && method === 'GET') {
        return {
          json: {
            deviceName: this.deviceName,
            demo: false,
            baseUrl: `http://${this.ip}:${this.port}`,
            // The PIN and QR secret live on the phone screen only.
            network: { address: this.ip, port: this.port },
            sessionCount: this.pairing.list().length,
          },
        };
      }

      if (path === '/api/pair' && method === 'POST') {
        const body = this.jsonBody(request);
        const session = this.pairing.pair({
          pin: body.pin as string | undefined,
          code: body.code as string | undefined,
          clientName: (body.clientName as string) ?? 'Desktop browser',
          ip: request.headers['x-forwarded-for'] ?? 'lan',
        });
        this.emit();
        return {
          status: 201,
          json: {
            token: session.token,
            expiresAt: new Date(session.expiresAt).toISOString(),
            session: {
              id: session.id,
              clientName: session.clientName,
              method: session.method,
              createdAt: new Date(session.createdAt).toISOString(),
            },
            device: { name: this.deviceName, baseUrl: `http://${this.ip}:${this.port}`, network: { address: this.ip, port: this.port } },
            locations: SHARED_FOLDERS.map((folder) => ({
              id: folder.id,
              label: folder.label,
              path: `/${folder.name}`,
              icon: folder.id,
            })),
            permissions: { read: true, write: true, delete: true },
          },
        };
      }

      // Signed grants are the only data route a browser can hit without a token:
      // <img>/<video>/download links cannot attach an Authorization header.
      if (path === '/api/asset' && (method === 'GET' || method === 'HEAD')) {
        const grant = this.assets.get(String(request.query.grant ?? ''));
        if (!grant || grant.expiresAt < Date.now()) {
          throw new PairingError('This link expired. Refresh the file list.', 403, 'invalid_grant');
        }
        return {
          filePath: this.absolute(grant.path),
          mime: mimeOf(grant.path),
          name: grant.path.replace(/^.*\//, ''),
          download: grant.mode === 'download',
        };
      }

      // Everything below requires a paired session.
      const session = this.requireSession(request);

      if (path === '/api/session' && method === 'GET') {
        return {
          json: {
            session: {
              id: session.id,
              clientName: session.clientName,
              method: session.method,
              createdAt: new Date(session.createdAt).toISOString(),
              expiresAt: new Date(session.expiresAt).toISOString(),
            },
            device: { name: this.deviceName, baseUrl: `http://${this.ip}:${this.port}`, network: { address: this.ip, port: this.port } },
            locations: SHARED_FOLDERS.map((folder) => ({ id: folder.id, label: folder.label, path: `/${folder.name}`, icon: folder.id })),
          },
        };
      }

      if (path === '/api/session/logout' && method === 'POST') {
        this.pairing.revoke(session.token);
        this.emit();
        return { json: { ok: true } };
      }

      if (path === '/api/sessions' && method === 'GET') {
        return { json: { sessions: this.pairing.list() } };
      }

      if (path.startsWith('/api/sessions/') && method === 'DELETE') {
        const id = path.slice('/api/sessions/'.length);
        this.pairing.revokeById(id);
        this.emit();
        return { json: { revoked: id } };
      }

      if (path === '/api/fs/locations' && method === 'GET') {
        const locations = await Promise.all(
          SHARED_FOLDERS.map(async (folder) => {
            const entries = await this.readDir(`/${folder.name}`);
            return { id: folder.id, label: folder.label, path: `/${folder.name}`, icon: folder.id, exists: true, count: entries.length };
          }),
        );
        return { json: { locations } };
      }

      if (path === '/api/fs/list' && method === 'GET') {
        const virtualPath = normaliseVirtualPath(request.query.path ?? '/');
        return { json: { path: virtualPath, parent: virtualPath === '/' ? null : virtualPath.replace(/\/[^/]+$/, '') || '/', entries: await this.readDir(virtualPath) } };
      }

      if (path === '/api/storage' && method === 'GET') {
        try {
          const info = await RNFS.getFSInfo();
          const shared = await this.directorySize(this.root);
          return {
            json: {
              storage: {
                total: info.totalSpace,
                free: info.freeSpace,
                used: info.totalSpace - info.freeSpace,
                sharedBytes: shared,
              },
            },
          };
        } catch {
          return { json: { storage: { total: null, free: null, used: null, sharedBytes: await this.directorySize(this.root) } } };
        }
      }

      if (path === '/api/fs/mkdir' && method === 'POST') {
        const body = this.jsonBody(request);
        const parent = normaliseVirtualPath((body.path as string) ?? '/');
        const name = String(body.name ?? '');
        if (!name || name.includes('/') || name === '.' || name === '..') {
          throw new PairingError('Invalid folder name', 400, 'invalid_name');
        }
        const target = this.absolute(parent === '/' ? `/${name}` : `${parent}/${name}`);
        await RNFS.mkdir(target);
        return { status: 201, json: { entry: await this.statEntry(`/${[parent, name].filter(Boolean).join('/')}`.replace('//', '/')) } };
      }

      if (path === '/api/fs/delete' && method === 'POST') {
        const body = this.jsonBody(request);
        const paths = (body.paths as string[]) ?? [(body.path as string)].filter(Boolean);
        for (const target of paths) {
          const virtual = normaliseVirtualPath(target);
          if (virtual === '/') throw new PairingError('You cannot delete the shared root', 400, 'invalid_path');
          await RNFS.unlink(this.absolute(virtual));
        }
        return { json: { removed: paths } };
      }

      if (path === '/api/asset' && method === 'POST') {
        const body = this.jsonBody(request);
        const assetPath = normaliseVirtualPath(String(body.path ?? '/'));
        const grant = `${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
        this.assets.set(grant, {
          path: assetPath,
          sessionId: session.id,
          mode: body.mode === 'download' ? 'download' : 'inline',
          expiresAt: Date.now() + 10 * 60 * 1000,
        });
        const params = new URLSearchParams({ path: assetPath, mode: body.mode === 'download' ? 'download' : 'inline', grant });
        return { json: { url: `/api/asset?${params.toString()}` } };
      }

      if (path === '/api/upload' && (method === 'PUT' || method === 'HEAD' || method === 'GET')) {
        return this.handleUpload(request);
      }

      if (path === '/api/upload/finish' && method === 'POST') {
        return this.finishUpload(this.jsonBody(request));
      }

      if (path.startsWith('/api/upload/') && method === 'DELETE') {
        const id = path.slice('/api/upload/'.length);
        const record = this.uploads.get(id);
        if (record) await RNFS.unlink(record.tempPath).catch(() => undefined);
        this.uploads.delete(id);
        return { json: { ok: true } };
      }

      throw new PairingError(`No route for ${method} ${path}`, 404, 'not_found');
    } catch (error) {
      if (error instanceof PairingError) {
        return {
          status: error.status,
          json: { error: { code: error.code, message: error.message, ...(error.retryAfter ? { retryAfter: error.retryAfter } : {}) } },
        };
      }
      return {
        status: 500,
        json: { error: { code: 'internal_error', message: error instanceof Error ? error.message : 'Unknown error' } },
      };
    }
  }

  // ------------------------------------------------------------------ helpers

  private requireSession(request: HttpRequest): Session {
    const header = request.headers.authorization ?? '';
    const token = header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : request.query.token;
    const session = this.pairing.authenticate(token);
    if (!session) throw new PairingError('Pair with this device first.', 401, 'unauthenticated');
    return session;
  }

  private jsonBody(request: HttpRequest): Record<string, unknown> {
    try {
      return JSON.parse(request.body.toString('utf8') || '{}') as Record<string, unknown>;
    } catch {
      throw new PairingError('Invalid JSON body', 400, 'invalid_json');
    }
  }

  private absolute(virtualPath: string): string {
    const virtual = normaliseVirtualPath(virtualPath);
    return `${this.root}${virtual === '/' ? '' : virtual}`;
  }

  private async readDir(virtualPath: string) {
    const directory = this.absolute(virtualPath);
    let items: DirItem[];
    try {
      items = (await RNFS.readDir(directory)) as unknown as DirItem[];
    } catch {
      throw new PairingError('Folder not found', 404, 'not_found');
    }
    return items
      .map((item) => {
        const isDir = item.isDirectory();
        const name = item.name;
        const path = `${virtualPath === '/' ? '' : virtualPath}/${name}`.replace('//', '/');
        const size = isDir ? null : Number(item.size);
        const mtime = new Date(item.mtime ?? Date.now()).toISOString();
        return {
          name,
          path,
          type: isDir ? 'dir' : 'file',
          size,
          mtime,
          ext: isDir ? '' : extensionOf(name),
          mime: isDir ? null : mimeOf(name),
          kind: isDir ? 'folder' : kindOf(name),
          inline: !isDir && ['image', 'video', 'audio', 'pdf', 'text', 'code'].includes(kindOf(name)),
        };
      })
      .sort((a, b) => {
        if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
  }

  private async statEntry(virtualPath: string) {
    const absolute = this.absolute(virtualPath);
    const stat = (await RNFS.stat(absolute)) as unknown as StatLike;
    const name = virtualPath.replace(/^.*\//, '');
    return {
      name,
      path: virtualPath,
      type: stat.isDirectory() ? 'dir' : 'file',
      size: stat.isDirectory() ? null : Number(stat.size),
      mtime: new Date(stat.mtime ?? Date.now()).toISOString(),
      ext: extensionOf(name),
      mime: stat.isDirectory() ? null : mimeOf(name),
      kind: stat.isDirectory() ? 'folder' : kindOf(name),
      inline: !stat.isDirectory() && ['image', 'video', 'audio', 'pdf', 'text', 'code'].includes(kindOf(name)),
    };
  }

  private async directorySize(directory: string, depth = 0): Promise<number> {
    if (depth > 5) return 0;
    let total = 0;
    const items = await RNFS.readDir(directory).catch(() => [] as DirItem[]);
    for (const item of items) {
      if (item.isDirectory()) total += await this.directorySize(item.path, depth + 1);
      else total += Number(item.size) || 0;
    }
    return total;
  }

  private async handleUpload(request: HttpRequest): Promise<HandlerResult> {
    const id = request.headers['x-upload-id'];
    if (!id || !/^[A-Za-z0-9_-]{8,80}$/.test(id)) {
      throw new PairingError('Invalid upload id', 400, 'invalid_upload_id');
    }
    const record = this.uploads.get(id);
    if (request.method === 'GET' || request.method === 'HEAD') {
      if (!record) throw new PairingError('Unknown upload', 404, 'unknown_upload');
      const offset = await this.fileSize(record.tempPath);
      return {
        json: { id, offset, size: record.size, complete: record.size !== null && offset >= record.size, path: record.dir },
      };
    }

    const offsetHeader = request.headers['x-upload-offset'];
    if (offsetHeader === undefined) {
      const dir = normaliseVirtualPath(decodeURIComponent(request.headers['x-upload-dir'] ?? '/'));
      const rawName = decodeURIComponent(request.headers['x-upload-name'] ?? '');
      if (!rawName || rawName.includes('/')) throw new PairingError('Invalid file name', 400, 'invalid_name');
      const tempPath = `${this.uploadsDir}/${id}.part`;
      const sizeHeader = request.headers['x-upload-size'];
      const size = sizeHeader ? Number(sizeHeader) : null;
      const existing = record ?? { id, tempPath, dir, name: rawName, size };
      this.uploads.set(id, existing);
      if (!record) await RNFS.writeFile(tempPath, '', 'utf8');
      const offset = await this.fileSize(tempPath);
      return { status: 201, json: { uploadId: id, offset, size: existing.size, name: existing.name, path: existing.dir } };
    }

    if (!record) throw new PairingError('Unknown upload', 404, 'unknown_upload');
    const offset = Number(offsetHeader);
    const current = await this.fileSize(record.tempPath);
    if (offset !== current) {
      throw new PairingError('Upload offset mismatch', 409, 'offset_mismatch');
    }
    const base64 = request.body.toString('base64');
    if (base64) await RNFS.appendFile(record.tempPath, base64, 'base64');
    const written = await this.fileSize(record.tempPath);
    return {
      json: { uploadId: id, offset: written, size: record.size, complete: record.size !== null && written >= record.size, path: record.dir },
    };
  }

  private async finishUpload(body: Record<string, unknown>): Promise<HandlerResult> {
    const id = String(body.uploadId ?? '');
    const record = this.uploads.get(id);
    if (!record) throw new PairingError('Unknown upload', 404, 'unknown_upload');
    const written = await this.fileSize(record.tempPath);
    if (record.size !== null && written < record.size) {
      throw new PairingError('Upload is not complete yet', 409, 'incomplete');
    }
    const dir = this.absolute(record.dir);
    await RNFS.mkdir(dir);
    let name = record.name;
    let target = `${dir}/${name}`;
    let counter = 1;
    while (await RNFS.exists(target)) {
      const dot = record.name.lastIndexOf('.');
      name = dot > 0 ? `${record.name.slice(0, dot)} (${counter})${record.name.slice(dot)}` : `${record.name} (${counter})`;
      target = `${dir}/${name}`;
      counter += 1;
    }
    await RNFS.moveFile(record.tempPath, target);
    this.uploads.delete(id);
    const virtual = `${record.dir === '/' ? '' : record.dir}/${name}`;
    this.emit();
    return { status: 201, json: { entry: await this.statEntry(virtual) } };
  }

  private async fileSize(path: string): Promise<number> {
    try {
      const stat = await RNFS.stat(path);
      return Number(stat.size) || 0;
    } catch {
      return 0;
    }
  }

  /** Used by the Files tab (same code path the HTTP API uses). */
  async browse(virtualPath: string) {
    return this.readDir(normaliseVirtualPath(virtualPath));
  }

  async storage() {
    try {
      const info = await RNFS.getFSInfo();
      return {
        total: info.totalSpace,
        free: info.freeSpace,
        used: info.totalSpace - info.freeSpace,
        sharedBytes: await this.directorySize(this.root),
      };
    } catch {
      return { total: null, free: null, used: null, sharedBytes: await this.directorySize(this.root) };
    }
  }

  summary() {
    return {
      isRunning: this.isRunning,
      port: this.port,
      ip: this.ip,
      deviceName: this.deviceName,
      pin: this.pairing.pin,
      pairingUrl: this.pairingUrl,
      activeSessions: this.pairing.list(),
      connections: this.connections,
      lastError: this.lastError,
    };
  }
}
