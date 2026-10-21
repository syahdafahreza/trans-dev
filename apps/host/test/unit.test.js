import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import { describeFile } from '../src/lib/mime.js';
import {
  PathError,
  assertValidName,
  normalizeVirtualPath,
  resolveVirtualPath,
  uniqueName,
  virtualBasename,
  virtualDirname,
  virtualJoin,
} from '../src/lib/paths.js';
import { PairingService } from '../src/pairing.js';
import { AssetSigner } from '../src/signer.js';
import { UploadManager } from '../src/uploads.js';

describe('virtual paths', () => {
  it('normalises sloppy paths', () => {
    assert.equal(normalizeVirtualPath(''), '/');
    assert.equal(normalizeVirtualPath('/'), '/');
    assert.equal(normalizeVirtualPath('Inbox'), '/Inbox');
    assert.equal(normalizeVirtualPath('//Inbox///Trip/'), '/Inbox/Trip');
    assert.equal(normalizeVirtualPath('/Inbox/./a.txt'), '/Inbox/a.txt');
    assert.equal(normalizeVirtualPath('\\Inbox\\a.txt'), '/Inbox/a.txt');
  });

  it('rejects traversal instead of clamping it', () => {
    assert.throws(() => normalizeVirtualPath('/Inbox/../../etc/passwd'), PathError);
    assert.throws(() => normalizeVirtualPath('..'), PathError);
    assert.throws(() => normalizeVirtualPath('/a/\u0000/b'), PathError);
  });

  it('keeps resolved paths inside the root', () => {
    const root = path.resolve(os.tmpdir(), 'transdev-root');
    assert.equal(resolveVirtualPath(root, '/Inbox/a.txt').absolutePath, path.join(root, 'Inbox/a.txt'));
    assert.throws(() => resolveVirtualPath(root, '/../etc'), PathError);
  });

  it('splits virtual paths', () => {
    assert.equal(virtualDirname('/Inbox/Trip/a.jpg'), '/Inbox/Trip');
    assert.equal(virtualDirname('/a'), '/');
    assert.equal(virtualDirname('/'), '/');
    assert.equal(virtualBasename('/Inbox/a.jpg'), 'a.jpg');
    assert.equal(virtualJoin('/', 'a.jpg'), '/a.jpg');
    assert.equal(virtualJoin('/Inbox', 'a.jpg'), '/Inbox/a.jpg');
  });

  it('validates single file names', () => {
    assert.equal(assertValidName('holiday.jpg'), 'holiday.jpg');
    assert.throws(() => assertValidName('../evil'), PathError);
    assert.throws(() => assertValidName('a/b'), PathError);
    assert.throws(() => assertValidName(''), PathError);
  });

  it('picks a non colliding name', () => {
    const taken = new Set(['photo.jpg', 'photo (1).jpg']);
    assert.equal(uniqueName('photo.jpg', taken), 'photo (2).jpg');
    assert.equal(uniqueName('other.png', taken), 'other.png');
    assert.equal(uniqueName('PHOTO.JPG', taken), 'PHOTO (2).JPG');
  });
});

describe('mime detection', () => {
  it('maps common extensions', () => {
    assert.deepEqual(describeFile('a.JPG'), { ext: 'jpg', mime: 'image/jpeg', kind: 'image', inline: true });
    assert.equal(describeFile('clip.mp4').kind, 'video');
    assert.equal(describeFile('doc.pdf').inline, true);
    assert.equal(describeFile('bundle.zip').kind, 'archive');
    assert.equal(describeFile('no-extension').kind, 'file');
    assert.equal(describeFile('script.ts').kind, 'code');
  });
});

describe('pairing service', () => {
  function makeService(now = () => 1_700_000_000_000) {
    return new PairingService({ deviceName: 'Test phone', now, sessionTtlMs: 60_000 });
  }

  it('issues a session for the right PIN', () => {
    const pairing = makeService();
    const session = pairing.pair({ pin: pairing.pin, ip: '10.0.0.2' });
    assert.match(session.token, /^[A-Za-z0-9_-]{40,}$/);
    assert.equal(pairing.authenticate(session.token)?.id, session.id);
    assert.equal(pairing.authenticate('nope'), null);
  });

  it('accepts a QR code once and rejects it after rotation', () => {
    const pairing = makeService();
    const code = pairing.qrCode;
    const session = pairing.pair({ code, ip: '10.0.0.3' });
    assert.equal(session.method, 'qr');
    pairing.rotateQr();
    assert.throws(() => pairing.pair({ code, ip: '10.0.0.3' }), /not right/);
  });

  it('expires the QR code', () => {
    let clock = 1_700_000_000_000;
    const pairing = new PairingService({ now: () => clock, qrTtlMs: 1000 });
    clock += 2000;
    assert.throws(() => pairing.pair({ code: pairing.qrCode, ip: '10.0.0.4' }), /not right/);
  });

  it('locks an IP out after repeated failures', () => {
    const pairing = makeService();
    for (let attempt = 0; attempt < 4; attempt += 1) {
      assert.throws(() => pairing.pair({ pin: '0000' === pairing.pin ? '1111' : '0000', ip: '10.0.0.9' }));
    }
    const failure = (() => {
      try {
        pairing.pair({ pin: '9999' === pairing.pin ? '1111' : '9999', ip: '10.0.0.9' });
      } catch (error) {
        return error;
      }
      return null;
    })();
    assert.equal(failure?.status, 429);
    assert.throws(() => pairing.pair({ pin: pairing.pin, ip: '10.0.0.9' }), /Too many attempts/);
    // a different device on the network is unaffected
    assert.ok(pairing.pair({ pin: pairing.pin, ip: '10.0.0.10' }).token);
  });

  it('expires and revokes sessions', () => {
    let clock = 1_700_000_000_000;
    const pairing = new PairingService({ now: () => clock, sessionTtlMs: 500 });
    const session = pairing.pair({ pin: pairing.pin, ip: '10.0.0.5' });
    clock += 600;
    assert.equal(pairing.authenticate(session.token), null);
    const another = pairing.pair({ pin: pairing.pin, ip: '10.0.0.5' });
    assert.equal(pairing.revoke(another.token), true);
    assert.equal(pairing.authenticate(another.token), null);
  });
});

describe('asset signatures', () => {
  it('verifies a fresh signature and rejects tampering', () => {
    const signer = new AssetSigner(Buffer.from('test-secret'));
    const { exp, signature } = signer.sign({ sessionId: 'abc123', path: '/Inbox/a.jpg', mode: 'inline' });
    assert.equal(signer.verify({ sessionId: 'abc123', path: '/Inbox/a.jpg', mode: 'inline', exp, signature }), true);
    assert.equal(signer.verify({ sessionId: 'abc123', path: '/Inbox/b.jpg', mode: 'inline', exp, signature }), false);
    assert.equal(signer.verify({ sessionId: 'abc123', path: '/Inbox/a.jpg', mode: 'download', exp, signature }), false);
    assert.equal(signer.verify({ sessionId: 'other', path: '/Inbox/a.jpg', mode: 'inline', exp, signature }), false);
    assert.equal(signer.verify({ sessionId: 'abc123', path: '/Inbox/a.jpg', mode: 'inline', exp, signature: 'x' }), false);
  });

  it('rejects expired signatures', () => {
    const signer = new AssetSigner(Buffer.from('test-secret'));
    const { exp, signature } = signer.sign({ sessionId: 's', path: '/a', ttlMs: -1000 });
    assert.equal(signer.verify({ sessionId: 's', path: '/a', exp, signature }), false);
  });

  it('builds a self contained URL', () => {
    const signer = new AssetSigner(Buffer.from('test-secret'));
    const url = signer.urlFor({ sessionId: 'sess', path: '/Inbox/my file.jpg', mode: 'download' });
    assert.match(url, /^\/api\/asset\?path=%2FInbox%2Fmy\+file\.jpg/);
    assert.match(url, /mode=download/);
    assert.match(url, /sig=/);
  });
});

describe('upload manager', () => {
  const dirs = [];
  after(async () => {
    await Promise.all(dirs.map((dir) => fs.rm(dir, { recursive: true, force: true })));
  });

  async function manager() {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'transdev-upload-'));
    dirs.push(dir);
    return new UploadManager({ tmpDir: dir, maxBytes: 1024 * 1024 });
  }

  it('appends chunks and reports offsets', async () => {
    const uploads = await manager();
    await uploads.begin({ id: 'abcdefgh1234', dir: '/Inbox', name: 'test.txt', size: 10 });
    const first = await uploads.write({
      id: 'abcdefgh1234',
      offset: 0,
      stream: (await import('node:stream')).Readable.from([Buffer.from('hello')]),
    });
    assert.deepEqual(first, { offset: 5, size: 10, complete: false });
    const second = await uploads.write({
      id: 'abcdefgh1234',
      offset: 5,
      stream: (await import('node:stream')).Readable.from([Buffer.from('world')]),
    });
    assert.equal(second.complete, true);
    const target = path.join(uploads.tmpDir, '..', 'finished.txt');
    await uploads.finish('abcdefgh1234', { targetAbsolutePath: target });
    assert.equal(await fs.readFile(target, 'utf8'), 'helloworld');
    await fs.rm(target, { force: true });
  });

  it('refuses a mismatched offset', async () => {
    const uploads = await manager();
    await uploads.begin({ id: 'offset123456', dir: '/Inbox', name: 'x.bin', size: 4 });
    await assert.rejects(
      uploads.write({ id: 'offset123456', offset: 3, stream: (await import('node:stream')).Readable.from([Buffer.from('ab')]) }),
      (error) => error.code === 'offset_mismatch' && error.expectedOffset === 0,
    );
  });

  it('refuses files above the device limit', async () => {
    const uploads = await manager();
    await assert.rejects(
      uploads.begin({ id: 'toolarge12345', dir: '/Inbox', name: 'big.bin', size: 5 * 1024 * 1024 }),
      (error) => error.status === 413,
    );
  });

  it('resumes metadata for an existing upload id', async () => {
    const uploads = await manager();
    await uploads.begin({ id: 'resume1234567', dir: '/Inbox', name: 'resume.bin', size: 100 });
    const again = await uploads.begin({ id: 'resume1234567', dir: '/Inbox', name: 'ignored.bin', size: 100 });
    assert.equal(again.resumed, true);
    assert.equal(again.name, 'resume.bin');
  });

  it('ignores unsafe upload ids', async () => {
    const uploads = await manager();
    await assert.rejects(uploads.readMeta('../../etc/passwd'), (error) => error.code === 'invalid_upload_id');
  });
});
