import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import QRCode from 'qrcode';

import { FileService } from './files.js';
import { createRouter } from './http/router.js';
import { bearerToken, error, json, readJsonBody, setCors, setSecurityHeaders } from './http/respond.js';
import { sendFile } from './http/stream.js';
import { PathError, assertValidName, virtualDirname } from './lib/paths.js';
import { describeFile } from './lib/mime.js';
import { PairingError, PairingService } from './pairing.js';
import { RelayService } from './relay.js';
import { AssetSigner } from './signer.js';
import { UploadError, UploadManager } from './uploads.js';
import { createStaticHandler } from './http/static.js';

export const SHARE_LOCATIONS = [
  { id: 'inbox', label: 'Inbox', path: '/Inbox', icon: 'inbox', hint: 'Files other devices sent you' },
  { id: 'photos', label: 'Photos', path: '/Photos', icon: 'image', hint: 'Camera roll' },
  { id: 'documents', label: 'Documents', path: '/Documents', icon: 'document', hint: 'Shared documents' },
  { id: 'downloads', label: 'Downloads', path: '/Downloads', icon: 'download', hint: 'Saved from the web' },
];

export function localAddresses() {
  const addresses = [];
  for (const [name, infos] of Object.entries(os.networkInterfaces())) {
    for (const info of infos ?? []) {
      if (info.family !== 'IPv4' || info.internal) continue;
      addresses.push({ name, address: info.address });
    }
  }
  return addresses;
}

function pickLanAddress() {
  const addresses = localAddresses();
  const preferred = addresses.find((a) => /^192\.168\./.test(a.address))
    ?? addresses.find((a) => /^10\./.test(a.address))
    ?? addresses.find((a) => /^172\.(1[6-9]|2\d|3[01])\./.test(a.address))
    ?? addresses[0];
  return preferred?.address ?? '127.0.0.1';
}

export function createApp(config) {
  const pairing = new PairingService({
    deviceName: config.deviceName,
    pin: config.pin,
    sessionTtlMs: config.sessionTtlMs,
  });
  const files = new FileService({ root: config.root });
  const uploads = new UploadManager({ tmpDir: config.tmpDir, maxBytes: config.maxUploadBytes });
  const signer = new AssetSigner();
  const relay = new RelayService();
  const router = createRouter();
  const sseClients = new Set();
  const serveStatic = createStaticHandler(config.webDist);
  let booted = Date.now();

  const network = { address: pickLanAddress(), port: config.port };
  const baseUrl = () => config.publicUrl ?? `http://${network.address}:${network.port}`;
  const pairingUrl = () => `${baseUrl()}/?pin=${pairing.pin}`;

  function broadcast(event, data) {
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of sseClients) client.write(frame);
  }

  function requireSession(req, res) {
    const session = pairing.authenticate(bearerToken(req));
    if (!session) {
      error(res, 401, 'unauthenticated', 'Pair with this device first.');
      return null;
    }
    return session;
  }

  async function handleError(res, exception) {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    if (exception instanceof PairingError) {
      return error(res, exception.status, exception.code, exception.message, {
        ...(exception.retryAfter ? { retryAfter: exception.retryAfter } : {}),
      });
    }
    if (exception instanceof PathError || exception instanceof UploadError) {
      const { status = 400, code = 'bad_request', message, ...rest } = exception;
      return error(res, status, code, message, rest);
    }
    console.error('[trans-dev] unhandled error', exception);
    return error(res, 500, 'internal_error', 'Something went wrong on the phone.');
  }

  const route = (handler) => async (req, res, ctx) => {
    try {
      await handler(req, res, ctx);
    } catch (exception) {
      await handleError(res, exception);
    }
  };

  const authed = (handler) => route(async (req, res, ctx) => {
    const session = requireSession(req, res);
    if (!session) return;
    await handler(req, res, { ...ctx, session });
  });

  // ---------------------------------------------------------------- health / pairing

  router.get('/api/health', route(async (req, res) => {
    json(res, 200, {
      ok: true,
      name: 'trans-dev-host',
      deviceName: config.deviceName,
      uptimeMs: Date.now() - booted,
      version: '0.1.0',
    });
  }));

  router.get('/api/pair/info', route(async (req, res) => {
    json(res, 200, {
      deviceName: config.deviceName,
      demo: config.demo,
      baseUrl: baseUrl(),
      // A real phone never publishes its PIN, QR secret or pairing URL over the
      // network — it only renders them on its own screen. The demo host does, so
      // the flow can be tried without a device in hand.
      ...(config.demo
        ? {
            pin: pairing.pin,
            qrCode: pairing.qrCode,
            pairingUrl: pairingUrl(),
            qrExpiresAt: new Date(pairing.qrExpiresAt).toISOString(),
          }
        : {}),
      network,
      addresses: localAddresses(),
      sessionCount: pairing.publicSessions().length,
    });
  }));

  router.get('/api/pair/qr', route(async (req, res) => {
    const size = Math.min(Math.max(Number(req.query.size ?? 320) || 320, 160), 1024);
    if (!pairing.qrImage) {
      pairing.qrImage = await QRCode.toDataURL(pairingUrl(), {
        width: 640,
        margin: 1,
        color: { dark: '#0b1220', light: '#ffffff' },
        errorCorrectionLevel: 'M',
      });
    }
    const match = /^data:(image\/png);base64,(.+)$/.exec(pairing.qrImage);
    const buffer = Buffer.from(match[2], 'base64');
    res.writeHead(200, {
      'Content-Type': 'image/png',
      'Content-Length': buffer.length,
      'Cache-Control': 'no-store',
      'X-QR-Size': String(size),
    });
    res.end(buffer);
  }));

  router.get('/api/pair/qr.png', route(async (req, res) => {
    const buffer = await QRCode.toBuffer(pairingUrl(), { width: 640, margin: 1 });
    res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': buffer.length, 'Cache-Control': 'no-store' });
    res.end(buffer);
  }));

  router.post('/api/pair', route(async (req, res) => {
    const body = await readJsonBody(req);
    const ip = req.socket.remoteAddress ?? 'unknown';
    const session = pairing.pair({
      pin: body.pin,
      code: body.code,
      clientName: body.clientName,
      ip,
      userAgent: req.headers['user-agent'] ?? '',
    });
    broadcast('pairing', { type: 'paired', session: { id: session.id, clientName: session.clientName } });
    json(res, 201, {
      token: session.token,
      expiresAt: new Date(session.expiresAt).toISOString(),
      session: {
        id: session.id,
        clientName: session.clientName,
        method: session.method,
        createdAt: new Date(session.createdAt).toISOString(),
      },
      device: {
        name: config.deviceName,
        baseUrl: baseUrl(),
        network,
      },
      locations: SHARE_LOCATIONS,
      permissions: { read: true, write: true, delete: true },
    });
  }));

  // Simulates the phone scanning the QR shown on the desktop (desktop-first pairing).
  router.post('/api/pair/scan', route(async (req, res) => {
    const body = await readJsonBody(req);
    const raw = String(body.url ?? body.code ?? '').trim();
    const code = raw.includes('pin=') ? new URLSearchParams(raw.split('?')[1] ?? '').get('pin') : raw;
    if (!/^\d{4}$/.test(String(code ?? ''))) throw new PairingError('No PIN found in that code', { status: 400 });
    const matched = pairing.pin === code;
    json(res, 200, {
      matched,
      deviceName: config.deviceName,
      message: matched
        ? 'Code accepted. Approve on your phone to finish pairing.'
        : 'That code belongs to a different device.',
    });
  }));

  // ----------------------------------------------------------------------- session

  router.get('/api/session', authed(async (req, res, { session }) => {
    json(res, 200, {
      session: {
        id: session.id,
        clientName: session.clientName,
        method: session.method,
        createdAt: new Date(session.createdAt).toISOString(),
        expiresAt: new Date(session.expiresAt).toISOString(),
      },
      device: { name: config.deviceName, baseUrl: baseUrl(), network },
      locations: SHARE_LOCATIONS,
    });
  }));

  router.get('/api/sessions', authed(async (req, res) => {
    json(res, 200, { sessions: pairing.publicSessions() });
  }));

  router.delete('/api/sessions/:id', authed(async (req, res, { session, params }) => {
    if (session.id === params.id) {
      pairing.revoke(session.token);
    } else {
      pairing.revokeById(params.id);
    }
    broadcast('pairing', { type: 'revoked', sessionId: params.id });
    json(res, 200, { revoked: params.id });
  }));

  router.post('/api/session/logout', authed(async (req, res, { session }) => {
    pairing.revoke(session.token);
    json(res, 200, { ok: true });
  }));

  // -------------------------------------------------------------------- file access

  router.get('/api/fs/locations', authed(async (req, res) => {
    const locations = await files.locations(SHARE_LOCATIONS);
    json(res, 200, { locations });
  }));

  router.get('/api/fs/list', authed(async (req, res) => {
    const listing = await files.list(req.query.path ?? '/', { showHidden: req.query.hidden === '1' });
    json(res, 200, listing);
  }));

  router.get('/api/fs/stat', authed(async (req, res) => {
    json(res, 200, { entry: await files.stat(req.query.path ?? '/') });
  }));

  router.get('/api/fs/search', authed(async (req, res) => {
    const term = String(req.query.q ?? '').trim().toLowerCase();
    if (term.length < 2) return json(res, 200, { query: term, results: [] });
    const start = req.query.path ?? '/';
    const maxResults = Math.min(Number(req.query.limit ?? 60) || 60, 200);
    const results = [];

    async function walk(virtualDir, depth) {
      if (results.length >= maxResults || depth > 8) return;
      const listing = await files.list(virtualDir).catch(() => null);
      if (!listing) return;
      for (const entry of listing.entries) {
        if (results.length >= maxResults) return;
        if (entry.name.toLowerCase().includes(term)) results.push(entry);
        if (entry.type === 'dir') await walk(entry.path, depth + 1);
      }
    }
    await walk(start, 0);
    json(res, 200, { query: term, results });
  }));

  router.get('/api/storage', authed(async (req, res) => {
    json(res, 200, { storage: await files.storage() });
  }));

  router.post('/api/fs/mkdir', authed(async (req, res) => {
    const body = await readJsonBody(req);
    const parent = body.path ?? '/';
    assertValidName(body.name);
    if (body.name === '.' || body.name === '..') throw new PathError('Invalid folder name');
    const target = parent === '/' ? `/${body.name}` : `${parent}/${body.name}`;
    const entry = await files.mkdir(target);
    broadcast('fs', { type: 'created', path: entry.path });
    json(res, 201, { entry });
  }));

  router.post('/api/fs/rename', authed(async (req, res) => {
    const body = await readJsonBody(req);
    const entry = await files.rename(body.path, body.name);
    broadcast('fs', { type: 'moved', path: entry.path });
    json(res, 200, { entry });
  }));

  router.post('/api/fs/delete', authed(async (req, res) => {
    const body = await readJsonBody(req);
    const targets = Array.isArray(body.paths) ? body.paths : [body.path];
    if (!targets.length) throw new PathError('No files selected');
    const removed = [];
    for (const target of targets) {
      const result = await files.remove(target);
      removed.push(result.removed);
    }
    broadcast('fs', { type: 'deleted', paths: removed });
    json(res, 200, { removed });
  }));

  // Signed, header-free URLs for <img>, <video> and direct downloads.
  router.post('/api/asset', authed(async (req, res, { session }) => {
    const body = await readJsonBody(req);
    const mode = body.mode === 'download' ? 'download' : 'inline';
    const name = body.path?.split('/').pop() ?? 'file';
    const url = signer.urlFor({ sessionId: session.id, path: body.path ?? '/', mode, downloadName: name });
    json(res, 200, { url, mode });
  }));

  router.get('/api/asset', route(async (req, res) => {
    const { path: assetPath, mode = 'inline', exp, sig, s, name } = req.query;
    const sessionId = String(s ?? '');
    if (!pairing.sessionById(sessionId)) {
      return error(res, 401, 'unauthenticated', 'Pair with this device first.');
    }
    if (!signer.verify({ sessionId, path: assetPath, mode, exp, signature: sig })) {
      return error(res, 403, 'invalid_signature', 'This link expired. Refresh the file list.');
    }
    const resolved = await files.resolve(assetPath);
    const info = describeFile(resolved.absolutePath);
    const filename = String(name ?? path.basename(resolved.absolutePath));
    await sendFile(req, res, resolved.absolutePath, {
      mime: info.mime,
      name: filename,
      mode: mode === 'download' ? 'download' : 'inline',
      cacheControl: 'private, max-age=300',
    });
  }));

  // ------------------------------------------------------------------------ uploads

  async function startOrResume(req, res, { id, dir, name, size, createdAt }) {
    const target = await files.chooseTarget(dir ?? '/', name);
    const meta = await uploads.begin({ id, dir: target.virtualPath, name: target.name, size, createdAt });
    const offset = meta.offset ?? 0;
    json(res, meta.resumed ? 200 : 201, {
      uploadId: id,
      offset,
      size: meta.size,
      name: target.name,
      path: target.virtualPath,
      complete: meta.size !== null && offset >= meta.size,
    });
  }

  router.put('/api/upload', authed(async (req, res) => {
    const id = req.headers['x-upload-id'];
    const offsetHeader = req.headers['x-upload-offset'];

    // First request of a file: create the session, then append bytes from offset 0.
    if (offsetHeader === undefined) {
      // Header values are ASCII-safe encoded by the dashboard (non-ASCII file names).
      const decode = (value) => {
        try {
          return decodeURIComponent(String(value));
        } catch {
          return String(value);
        }
      };
      const dir = decode(req.headers['x-upload-dir'] ?? '/');
      const name = decode(req.headers['x-upload-name'] ?? '');
      const sizeHeader = req.headers['x-upload-size'];
      await startOrResume(req, res, {
        id,
        dir,
        name,
        size: sizeHeader === undefined ? null : Number(sizeHeader),
      });
      req.resume();
      return;
    }

    const meta = await uploads.readMeta(id);
    if (!meta) throw new UploadError('Unknown upload', { code: 'unknown_upload', status: 404 });
    const result = await uploads.write({ id, offset: Number(offsetHeader), stream: req });
    json(res, 200, {
      uploadId: id,
      offset: result.offset,
      size: result.size,
      complete: result.complete,
      path: meta.dir,
    });
  }));

  router.head('/api/upload', authed(async (req, res) => {
    const status = await uploads.status(req.query.id);
    res.writeHead(200, {
      'X-Upload-Offset': String(status.offset),
      'X-Upload-Size': status.size === null ? '' : String(status.size),
      'Cache-Control': 'no-store',
    });
    res.end();
  }));

  router.get('/api/upload', authed(async (req, res) => {
    json(res, 200, await uploads.status(req.query.id));
  }));

  router.post('/api/upload/finish', authed(async (req, res) => {
    const body = await readJsonBody(req);
    const meta = await uploads.readMeta(body.uploadId);
    if (!meta) throw new UploadError('Unknown upload', { code: 'unknown_upload', status: 404 });
    const target = await files.chooseTarget(virtualDirname(meta.dir), meta.name);
    const result = await uploads.finish(body.uploadId, { targetAbsolutePath: target.absolutePath });
    const entry = await files.stat(target.virtualPath);
    broadcast('fs', { type: 'uploaded', path: target.virtualPath, size: result.size });
    json(res, 201, { entry });
  }));

  router.delete('/api/upload/:id', authed(async (req, res, { params }) => {
    await uploads.abort(params.id);
    json(res, 200, { ok: true });
  }));

  /**
   * Single-request streaming upload for curl / scripts:
   *   curl -T movie.mp4 -H "Authorization: Bearer $TOKEN" "http://host:8787/api/upload/simple?dir=/Inbox"
   * The body is written straight to disk, so multi-GB files do not buffer in memory.
   */
  router.post('/api/upload/simple', authed(async (req, res) => {
    const dir = req.query.dir ?? '/';
    const rawName = req.query.name ?? String(req.headers['x-file-name'] ?? 'upload.bin');
    const name = decodeURIComponent(String(rawName));
    const target = await files.chooseTarget(dir, name);

    const { createWriteStream } = await import('node:fs');
    const { pipeline } = await import('node:stream/promises');
    const sink = createWriteStream(target.absolutePath, { flags: 'wx', highWaterMark: 1024 * 1024 });
    try {
      await pipeline(req, sink);
    } catch (exception) {
      const { rm } = await import('node:fs/promises');
      await rm(target.absolutePath, { force: true });
      throw new UploadError(`Upload failed: ${exception.message}`, { status: 400 });
    }
    const entry = await files.stat(target.virtualPath);
    broadcast('fs', { type: 'uploaded', path: target.virtualPath, size: entry.size });
    json(res, 201, { entry });
  }));

  // ------------------------------------------------------------------- realtime feed

  router.get('/api/events', route(async (req, res) => {
    const token = req.query.token ?? bearerToken(req);
    const session = pairing.authenticate(token);
    if (!session) return error(res, 401, 'unauthenticated', 'Pair with this device first.');

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(': connected\n\n');
    sseClients.add(res);

    const heartbeat = setInterval(() => res.write(': ping\n\n'), 25_000);
    req.on('close', () => {
      clearInterval(heartbeat);
      sseClients.delete(res);
    });
  }));

  // ------------------------------------------------------------------------- relay

  router.post('/api/relay/session', route(async (req, res) => {
    const body = await readJsonBody(req);
    const session = relay.create({
      baseUrl: body.baseUrl ?? baseUrl(),
      deviceName: body.deviceName ?? config.deviceName,
    });
    json(res, 201, {
      ...session,
      relayUrl: `${baseUrl()}/pair?relay=${session.code}`,
    });
  }));

  router.get('/api/relay/session/:code', route(async (req, res, { params }) => {
    const session = relay.get(params.code);
    if (!session) return error(res, 404, 'expired', 'That pairing code has expired.');
    json(res, 200, { code: session.code, baseUrl: session.baseUrl, deviceName: session.deviceName });
  }));

  // ------------------------------------------------------------------------- runtime

  async function handle(req, res) {
    const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
    const { pathname } = url;
    req.query = Object.fromEntries(url.searchParams.entries());
    setSecurityHeaders(res);
    setCors(res, req.headers.origin ?? '*');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    if (config.logRequests && !pathname.startsWith('/api/events')) {
      const started = Date.now();
      res.on('finish', () => {
        console.log(`${req.method} ${pathname} → ${res.statusCode} (${Date.now() - started}ms)`);
      });
    }

    const method = req.method === 'HEAD' ? 'HEAD' : req.method;
    const matched = router.match(method, pathname)
      ?? (method === 'HEAD' ? router.match('GET', pathname) : null);

    if (matched) {
      await matched.handler(req, res, { params: matched.params });
      return;
    }

    if ((req.method === 'GET' || req.method === 'HEAD') && !pathname.startsWith('/api/')) {
      const served = await serveStatic(req, res, pathname);
      if (served) return;
    }

    if (pathname.startsWith('/api/')) {
      error(res, 404, 'not_found', `No route for ${req.method} ${pathname}`);
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found. Build the dashboard with `npm run build` or run `npm run dev`.');
  }

  async function bootstrap() {
    await files.ensureRoot();
    for (const location of SHARE_LOCATIONS) {
      const { absolutePath } = await files.resolve(location.path);
      await fsp.mkdir(absolutePath, { recursive: true });
    }
    await uploads.ensureDir();
    await uploads.cleanup().catch(() => {});
    booted = Date.now();
  }

  return {
    handle,
    bootstrap,
    pairing,
    files,
    uploads,
    signer,
    relay,
    baseUrl,
    pairingUrl,
    get network() {
      return { ...network, baseUrl: baseUrl() };
    },
    setNetwork({ address, port }) {
      if (address) network.address = address;
      if (port) network.port = port;
    },
    shutdown() {
      for (const client of sseClients) client.end();
      sseClients.clear();
    },
  };
}
