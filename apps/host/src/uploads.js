import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export class UploadError extends Error {
  constructor(message, { code = 'upload_failed', status = 400, ...rest } = {}) {
    super(message);
    this.name = 'UploadError';
    this.code = code;
    this.status = status;
    Object.assign(this, rest);
  }
}

const ID_PATTERN = /^[A-Za-z0-9_-]{8,80}$/;
const META_VERSION = 1;

/**
 * Resumable, streaming uploads.
 *
 * The desktop sends the file in slices (`PUT` with `x-upload-offset`) and the server
 * appends each slice straight to a partial file on disk — the body is never buffered.
 * If the browser reloads, `HEAD` reports the byte offset so the upload resumes.
 * When the last byte lands the partial file is atomically moved into the shared folder.
 */
export class UploadManager {
  constructor({ tmpDir, maxBytes = 20 * 1024 * 1024 * 1024, now = () => Date.now() } = {}) {
    this.tmpDir = tmpDir;
    this.maxBytes = maxBytes;
    this.now = now;
  }

  async ensureDir() {
    await fsp.mkdir(this.tmpDir, { recursive: true });
  }

  metaPath(id) {
    return path.join(this.tmpDir, `${id}.json`);
  }

  partPath(id) {
    return path.join(this.tmpDir, `${id}.part`);
  }

  assertId(id) {
    if (!ID_PATTERN.test(String(id ?? ''))) {
      throw new UploadError('Invalid upload id', { code: 'invalid_upload_id', status: 400 });
    }
  }

  async readMeta(id) {
    this.assertId(id);
    try {
      const raw = await fsp.readFile(this.metaPath(id), 'utf8');
      return JSON.parse(raw);
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  }

  async partSize(id) {
    try {
      const stat = await fsp.stat(this.partPath(id));
      return stat.size;
    } catch (error) {
      if (error.code === 'ENOENT') return 0;
      throw error;
    }
  }

  async status(id) {
    const meta = await this.readMeta(id);
    if (!meta) throw new UploadError('Unknown upload', { code: 'unknown_upload', status: 404 });
    const offset = await this.partSize(id);
    return { ...meta, offset, complete: meta.size !== null && offset >= meta.size };
  }

  /** Creates or resumes an upload session. */
  async begin({ id, dir, name, size = null, createdAt = null }) {
    if (!id) throw new UploadError('Upload id is required');
    this.assertId(id);
    await this.ensureDir();

    const existing = await this.readMeta(id);
    if (existing) {
      const offset = await this.partSize(id);
      return { ...existing, offset, resumed: true };
    }

    const numericSize = size === null || size === undefined || size === '' ? null : Number(size);
    if (numericSize !== null && (!Number.isFinite(numericSize) || numericSize < 0)) {
      throw new UploadError('Invalid upload size', { code: 'invalid_size' });
    }
    if (numericSize !== null && numericSize > this.maxBytes) {
      throw new UploadError('File is larger than the device allows', { code: 'too_large', status: 413 });
    }

    const meta = {
      v: META_VERSION,
      id,
      dir,
      name,
      size: numericSize,
      createdAt: createdAt ?? new Date(this.now()).toISOString(),
    };
    await fsp.writeFile(this.metaPath(id), JSON.stringify(meta));
    await fsp.writeFile(this.partPath(id), '');
    return { ...meta, offset: 0, resumed: false };
  }

  /**
   * Streams one slice to disk. The stream comes straight from the HTTP request, so
   * backpressure keeps memory flat even for multi-gigabyte videos.
   */
  async write({ id, offset, stream }) {
    const meta = await this.readMeta(id);
    if (!meta) throw new UploadError('Unknown upload', { code: 'unknown_upload', status: 404 });

    const current = await this.partSize(id);
    if (Number(offset) !== current) {
      throw new UploadError('Upload offset mismatch', {
        code: 'offset_mismatch',
        status: 409,
        expectedOffset: current,
      });
    }

    const sink = fs.createWriteStream(this.partPath(id), { flags: 'a', highWaterMark: 1024 * 1024 });
    let received = current;
    // Count inside the pipeline: attaching a 'data' listener first would switch the
    // request stream to flowing mode and silently drop bytes before the sink attaches.
    const counter = new Transform({
      transform(chunk, _encoding, callback) {
        received += chunk.length;
        if (received > this.maxBytes) {
          callback(new UploadError('File is too large', { code: 'too_large', status: 413 }));
          return;
        }
        callback(null, chunk);
      },
    });

    try {
      await pipeline(stream, counter, sink);
    } catch (error) {
      await sink.destroy();
      if (meta.size !== null && received > meta.size) {
        await fsp.truncate(this.partPath(id), meta.size);
      }
      throw new UploadError(`Upload interrupted: ${error.message}`, { code: 'stream_failed', status: 400 });
    }

    const size = await this.partSize(id);
    if (meta.size !== null && size > meta.size) {
      await fsp.truncate(this.partPath(id), meta.size);
    }

    return {
      offset: Math.min(size, meta.size ?? size),
      size: meta.size,
      complete: meta.size !== null && size >= meta.size,
    };
  }

  /** Moves the finished partial file into its destination folder. */
  async finish(id, { targetAbsolutePath }) {
    const meta = await this.readMeta(id);
    if (!meta) throw new UploadError('Unknown upload', { code: 'unknown_upload', status: 404 });
    const size = await this.partSize(id);
    if (meta.size !== null && size < meta.size) {
      throw new UploadError('Upload is not complete yet', {
        code: 'incomplete',
        status: 409,
        expectedOffset: size,
      });
    }

    await fsp.mkdir(path.dirname(targetAbsolutePath), { recursive: true });
    try {
      await fsp.rename(this.partPath(id), targetAbsolutePath);
    } catch (error) {
      if (error.code !== 'EXDEV') throw error;
      await fsp.copyFile(this.partPath(id), targetAbsolutePath);
      await fsp.unlink(this.partPath(id));
    }
    await fsp.rm(this.metaPath(id), { force: true });
    return { path: targetAbsolutePath, size };
  }

  async abort(id) {
    this.assertId(id);
    await Promise.all([
      fsp.rm(this.partPath(id), { force: true }),
      fsp.rm(this.metaPath(id), { force: true }),
    ]);
  }

  /** Drops abandoned uploads so a phone does not fill up with stale partial files. */
  async cleanup({ olderThanMs = 24 * 60 * 60 * 1000 } = {}) {
    await this.ensureDir();
    const entries = await fsp.readdir(this.tmpDir).catch(() => []);
    const cutoff = this.now() - olderThanMs;
    let removed = 0;
    for (const entry of entries) {
      if (!entry.endsWith('.part')) continue;
      const id = entry.slice(0, -'.part'.length);
      const meta = await this.readMeta(id).catch(() => null);
      const stat = await fsp.stat(path.join(this.tmpDir, entry)).catch(() => null);
      const touched = meta ? Date.parse(meta.createdAt) : stat?.mtimeMs;
      if (touched && touched < cutoff) {
        await this.abort(id);
        removed += 1;
      }
    }
    return removed;
  }
}
