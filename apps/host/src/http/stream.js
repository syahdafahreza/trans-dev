import fs from 'node:fs';
import fsp from 'node:fs/promises';

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

export function contentTypeFor(filePath) {
  const idx = filePath.lastIndexOf('.');
  if (idx === -1) return 'application/octet-stream';
  return CONTENT_TYPES[filePath.slice(idx).toLowerCase()] ?? 'application/octet-stream';
}

function parseRange(header, size) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim());
  if (!match) return null;
  const [, rawStart, rawEnd] = match;
  if (rawStart === '' && rawEnd === '') return null;

  let start;
  let end;
  if (rawStart === '') {
    const suffix = Number(rawEnd);
    if (!Number.isFinite(suffix) || suffix <= 0) return null;
    start = Math.max(size - suffix, 0);
    end = size - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd === '' ? size - 1 : Number(rawEnd);
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) return null;
  return { start, end: Math.min(end, size - 1) };
}

function contentDisposition(name, mode) {
  const fallback = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  const encoded = encodeURIComponent(name);
  return `${mode === 'download' ? 'attachment' : 'inline'}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

/**
 * Streams a file with Range + conditional request support, so the browser can
 * seek video and resume interrupted downloads without loading the file into RAM.
 */
export async function sendFile(req, res, absolutePath, options = {}) {
  const {
    mime = 'application/octet-stream',
    name = 'file',
    mode = 'inline',
    cacheControl = 'private, max-age=60',
    etag: customEtag,
  } = options;

  let stat;
  try {
    stat = await fsp.stat(absolutePath);
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') {
      res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: { code: 'not_found', message: 'File not found' } }));
      return;
    }
    throw error;
  }
  if (!stat.isFile()) {
    res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: { code: 'not_a_file', message: 'Not a file' } }));
    return;
  }

  const etag = customEtag ?? `W/"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
  const lastModified = new Date(stat.mtimeMs).toUTCString();
  const headers = {
    'Content-Type': mime,
    'Accept-Ranges': 'bytes',
    ETag: etag,
    'Last-Modified': lastModified,
    'Cache-Control': cacheControl,
    'Content-Disposition': contentDisposition(name, mode),
    'X-Content-Type-Options': 'nosniff',
  };

  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, headers);
    res.end();
    return;
  }

  const rangeHeader = req.headers.range;
  if (rangeHeader) {
    const range = parseRange(rangeHeader, stat.size);
    if (!range) {
      res.writeHead(416, { ...headers, 'Content-Range': `bytes */${stat.size}` });
      res.end();
      return;
    }
    const { start, end } = range;
    res.writeHead(206, {
      ...headers,
      'Content-Range': `bytes ${start}-${end}/${stat.size}`,
      'Content-Length': end - start + 1,
    });
    if (req.method === 'HEAD') return res.end();
    const stream = fs.createReadStream(absolutePath, { start, end, highWaterMark: 256 * 1024 });
    stream.on('error', () => res.destroy());
    stream.pipe(res);
    req.on('close', () => stream.destroy());
    return;
  }

  res.writeHead(200, { ...headers, 'Content-Length': stat.size });
  if (req.method === 'HEAD') return res.end();
  const stream = fs.createReadStream(absolutePath, { highWaterMark: 256 * 1024 });
  stream.on('error', () => res.destroy());
  stream.pipe(res);
  req.on('close', () => stream.destroy());
}
