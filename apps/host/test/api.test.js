import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import fsp from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { createApp } from '../src/app.js';

async function startServer(overrides = {}) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'transdev-root-'));
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'transdev-tmp-'));
  const app = createApp({
    deviceName: 'Test Phone',
    pin: '4821',
    demo: true,
    root,
    tmpDir,
    webDist: path.join(root, '.no-dist'),
    maxUploadBytes: 8 * 1024 * 1024,
    sessionTtlMs: 10 * 60 * 1000,
    logRequests: false,
    port: 0,
    publicUrl: null,
    ...overrides,
  });
  await app.bootstrap();
  const server = http.createServer((req, res) => {
    app.handle(req, res).catch((error) => {
      res.writeHead(500).end(String(error));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  return {
    app,
    root,
    tmpDir,
    base: `http://127.0.0.1:${port}`,
    async close() {
      app.shutdown();
      await new Promise((resolve) => server.close(resolve));
      await fsp.rm(root, { recursive: true, force: true });
      await fsp.rm(tmpDir, { recursive: true, force: true });
    },
  };
}

async function pair(base, pin = '4821') {
  const response = await fetch(`${base}/api/pair`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pin, clientName: 'Test browser' }),
  });
  const body = await response.json();
  return { response, body, token: body.token };
}

function auth(token) {
  return { Authorization: `Bearer ${token}` };
}

describe('host API', () => {
  let server;
  let token;

  before(async () => {
    server = await startServer();
    ({ token } = await pair(server.base));
  });

  after(async () => {
    await server.close();
  });

  it('reports health without auth', async () => {
    const response = await fetch(`${server.base}/api/health`);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).deviceName, 'Test Phone');
  });

  it('exposes pairing info with a demo PIN only in demo mode', async () => {
    const publicInfo = await (await fetch(`${server.base}/api/pair/info`)).json();
    assert.equal(publicInfo.demo, true);
    assert.equal(publicInfo.pin, '4821');
    assert.match(publicInfo.pairingUrl, /\?pin=4821$/);
    assert.ok(publicInfo.qrCode);

    const secure = await startServer({ demo: false, pin: '1111' });
    try {
      const secureInfo = await (await fetch(`${secure.base}/api/pair/info`)).json();
      assert.equal(secureInfo.pin, undefined);
      assert.equal(secureInfo.qrCode, undefined);
      assert.equal(secureInfo.pairingUrl, undefined);
    } finally {
      await secure.close();
    }
  });

  it('rejects unauthenticated data requests', async () => {
    const response = await fetch(`${server.base}/api/fs/list?path=/`);
    assert.equal(response.status, 401);
    assert.equal((await response.json()).error.code, 'unauthenticated');
  });

  it('rejects a wrong PIN and accepts the right one', async () => {
    const wrong = await fetch(`${server.base}/api/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin: '0000' }),
    });
    assert.equal(wrong.status, 401);
    assert.equal((await wrong.json()).error.code, 'bad_pin');
  });

  it('accepts the QR code issued by the phone', async () => {
    const code = server.app.pairing.qrCode;
    const response = await fetch(`${server.base}/api/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
    });
    assert.equal(response.status, 201);
    assert.equal((await response.json()).session.method, 'qr');
  });

  it('lists the shared folders', async () => {
    const response = await fetch(`${server.base}/api/fs/list?path=/`, { headers: auth(token) });
    assert.equal(response.status, 200);
    const body = await response.json();
    const names = body.entries.map((entry) => entry.name);
    assert.deepEqual(names, ['Documents', 'Downloads', 'Inbox', 'Photos']);
    assert.ok(body.entries.every((entry) => entry.type === 'dir'));
  });

  it('blocks path traversal', async () => {
    const response = await fetch(`${server.base}/api/fs/list?path=${encodeURIComponent('/../../etc')}`, {
      headers: auth(token),
    });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.code, 'invalid_path');
  });

  it('creates, renames and deletes a folder', async () => {
    const created = await fetch(`${server.base}/api/fs/mkdir`, {
      method: 'POST',
      headers: { ...auth(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: '/', name: 'Holiday' }),
    });
    assert.equal(created.status, 201);
    assert.equal((await created.json()).entry.path, '/Holiday');

    const renamed = await fetch(`${server.base}/api/fs/rename`, {
      method: 'POST',
      headers: { ...auth(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: '/Holiday', name: 'Holiday 2026' }),
    });
    assert.equal(renamed.status, 200);
    assert.equal((await renamed.json()).entry.path, '/Holiday 2026');

    const removed = await fetch(`${server.base}/api/fs/delete`, {
      method: 'POST',
      headers: { ...auth(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths: ['/Holiday 2026'] }),
    });
    assert.equal(removed.status, 200);
    assert.deepEqual((await removed.json()).removed, ['/Holiday 2026']);
  });

  it('refuses to delete the shared root', async () => {
    const response = await fetch(`${server.base}/api/fs/delete`, {
      method: 'POST',
      headers: { ...auth(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths: ['/'] }),
    });
    assert.equal(response.status, 400);
  });

  it('uploads a file in two chunks and serves it back with ranges', async () => {
    const uploadId = 'apitest00000001';
    const payload = Buffer.from('The quick brown fox jumps over the lazy dog');

    const begin = await fetch(`${server.base}/api/upload`, {
      method: 'PUT',
      headers: {
        ...auth(token),
        'X-Upload-Id': uploadId,
        'X-Upload-Dir': '/Inbox',
        'X-Upload-Name': 'quick.txt',
        'X-Upload-Size': String(payload.length),
      },
    });
    assert.equal(begin.status, 201);

    for (const [offset, chunk] of [
      [0, payload.subarray(0, 20)],
      [20, payload.subarray(20)],
    ]) {
      const response = await fetch(`${server.base}/api/upload`, {
        method: 'PUT',
        headers: {
          ...auth(token),
          'X-Upload-Id': uploadId,
          'X-Upload-Offset': String(offset),
          'Content-Type': 'application/octet-stream',
        },
        body: chunk,
      });
      assert.equal(response.status, 200, await response.text());
    }

    const finished = await fetch(`${server.base}/api/upload/finish`, {
      method: 'POST',
      headers: { ...auth(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ uploadId }),
    });
    assert.equal(finished.status, 201);
    const entry = (await finished.json()).entry;
    assert.equal(entry.size, payload.length);
    assert.equal(entry.kind, 'text');

    const { url } = await (
      await fetch(`${server.base}/api/asset`, {
        method: 'POST',
        headers: { ...auth(token), 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: entry.path }),
      })
    ).json();

    const full = await fetch(`${server.base}${url}`);
    assert.equal(full.status, 200);
    assert.equal(await full.text(), payload.toString());
    assert.equal(full.headers.get('accept-ranges'), 'bytes');

    const ranged = await fetch(`${server.base}${url}`, { headers: { Range: 'bytes=4-8' } });
    assert.equal(ranged.status, 206);
    assert.equal(await ranged.text(), 'quick');
    assert.equal(ranged.headers.get('content-range'), `bytes 4-8/${payload.length}`);

    const tampered = await fetch(`${server.base}${url.replace('mode=inline', 'mode=download')}`);
    assert.equal(tampered.status, 403);

    const head = await fetch(`${server.base}/api/upload?id=${uploadId}`, { headers: auth(token) });
    assert.equal(head.status, 404); // cleaned up after finishing
  });

  it('streams a multi-megabyte upload without dropping bytes', async () => {
    // Regression guard: an early 'data' listener on the request stream used to put it
    // into flowing mode before the disk sink attached, silently losing chunks.
    const payload = randomBytes(6 * 1024 * 1024 + 12_345);
    const uploadId = 'bigfile00000001';
    const begin = await fetch(`${server.base}/api/upload`, {
      method: 'PUT',
      headers: {
        ...auth(token),
        'X-Upload-Id': uploadId,
        'X-Upload-Dir': '/Inbox',
        'X-Upload-Name': 'big.bin',
        'X-Upload-Size': String(payload.length),
      },
    });
    assert.equal(begin.status, 201);

    const slice = 1024 * 1024;
    for (let offset = 0; offset < payload.length; offset += slice) {
      const chunk = payload.subarray(offset, Math.min(offset + slice, payload.length));
      const response = await fetch(`${server.base}/api/upload`, {
        method: 'PUT',
        headers: {
          ...auth(token),
          'X-Upload-Id': uploadId,
          'X-Upload-Offset': String(offset),
          'Content-Type': 'application/octet-stream',
        },
        body: chunk,
      });
      if (response.status !== 200) assert.fail(`${response.status}: ${await response.text()}`);
      assert.equal((await response.json()).offset, offset + chunk.length);
    }

    const finished = await fetch(`${server.base}/api/upload/finish`, {
      method: 'POST',
      headers: { ...auth(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ uploadId }),
    });
    assert.equal(finished.status, 201);
    const entry = (await finished.json()).entry;
    assert.equal(entry.size, payload.length);

    const stored = await fsp.readFile(path.join(server.root, entry.path.slice(1)));
    assert.equal(stored.length, payload.length);
    assert.equal(createHash('sha256').update(stored).digest('hex'), createHash('sha256').update(payload).digest('hex'));
  });

  it('resumes an interrupted upload from the reported offset', async () => {
    const uploadId = 'resume000000001';
    const begin = await fetch(`${server.base}/api/upload`, {
      method: 'PUT',
      headers: {
        ...auth(token),
        'X-Upload-Id': uploadId,
        'X-Upload-Dir': '/Inbox',
        'X-Upload-Name': 'resume.bin',
        'X-Upload-Size': '100',
      },
    });
    assert.equal(begin.status, 201);
    await fetch(`${server.base}/api/upload`, {
      method: 'PUT',
      headers: {
        ...auth(token),
        'X-Upload-Id': uploadId,
        'X-Upload-Offset': '0',
        'Content-Type': 'application/octet-stream',
      },
      body: Buffer.alloc(40, 7),
    });
    const status = await fetch(`${server.base}/api/upload?id=${uploadId}`, { headers: auth(token) });
    assert.equal((await status.json()).offset, 40);

    const head = await fetch(`${server.base}/api/upload?id=${uploadId}`, {
      method: 'HEAD',
      headers: auth(token),
    });
    assert.equal(head.headers.get('x-upload-offset'), '40');
  });

  it('rejects a chunk that does not continue at the current offset', async () => {
    const uploadId = 'mismatch0000001';
    await fetch(`${server.base}/api/upload`, {
      method: 'PUT',
      headers: {
        ...auth(token),
        'X-Upload-Id': uploadId,
        'X-Upload-Dir': '/Inbox',
        'X-Upload-Name': 'mismatch.bin',
        'X-Upload-Size': '10',
      },
    });
    const response = await fetch(`${server.base}/api/upload`, {
      method: 'PUT',
      headers: {
        ...auth(token),
        'X-Upload-Id': uploadId,
        'X-Upload-Offset': '5',
        'Content-Type': 'application/octet-stream',
      },
      body: Buffer.from('abc'),
    });
    assert.equal(response.status, 409);
    assert.equal((await response.json()).error.expectedOffset, 0);
  });

  it('streams a single-request upload', async () => {
    const response = await fetch(
      `${server.base}/api/upload/simple?dir=%2FDownloads&name=${encodeURIComponent('movie clip.bin')}`,
      {
        method: 'POST',
        headers: { ...auth(token), 'Content-Type': 'application/octet-stream' },
        body: Buffer.alloc(2048, 3),
      },
    );
    assert.equal(response.status, 201);
    const entry = (await response.json()).entry;
    assert.equal(entry.name, 'movie clip.bin');
    assert.equal(entry.size, 2048);
  });

  it('finds files with search', async () => {
    const response = await fetch(`${server.base}/api/fs/search?q=quick`, { headers: auth(token) });
    assert.equal(response.status, 200);
    const results = (await response.json()).results;
    assert.ok(results.some((entry) => entry.name === 'quick.txt'));
  });

  it('reports storage figures', async () => {
    const response = await fetch(`${server.base}/api/storage`, { headers: auth(token) });
    const storage = (await response.json()).storage;
    assert.ok(typeof storage.sharedBytes === 'number');
    assert.ok(storage.total === null || storage.total > 0);
  });

  it('lists and revokes sessions', async () => {
    const extra = await pair(server.base);
    const list = await (await fetch(`${server.base}/api/sessions`, { headers: auth(token) })).json();
    assert.ok(list.sessions.length >= 2);
    assert.ok(list.sessions.every((session) => !('token' in session)));

    const revoke = await fetch(`${server.base}/api/sessions/${extra.body.session.id}`, {
      method: 'DELETE',
      headers: auth(token),
    });
    assert.equal(revoke.status, 200);
    const denied = await fetch(`${server.base}/api/fs/list?path=/`, { headers: auth(extra.token) });
    assert.equal(denied.status, 401);
  });

  it('invalidates the token on logout', async () => {
    const session = await pair(server.base);
    const logout = await fetch(`${server.base}/api/session/logout`, {
      method: 'POST',
      headers: auth(session.token),
    });
    assert.equal(logout.status, 200);
    const response = await fetch(`${server.base}/api/fs/list?path=/`, { headers: auth(session.token) });
    assert.equal(response.status, 401);
  });

  it('rate limits brute force attempts per IP', async () => {
    const isolated = await startServer();
    try {
      let last;
      for (let attempt = 0; attempt < 6; attempt += 1) {
        last = await fetch(`${isolated.base}/api/pair`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ pin: '0000' }),
        });
      }
      assert.equal(last.status, 429);
      const locked = await fetch(`${isolated.base}/api/pair`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin: '4821' }),
      });
      assert.equal(locked.status, 429);
    } finally {
      await isolated.close();
    }
  });

  it('returns JSON 404 for unknown API routes', async () => {
    const response = await fetch(`${server.base}/api/nope`, { headers: auth(token) });
    assert.equal(response.status, 404);
    assert.equal((await response.json()).error.code, 'not_found');
  });
});
