export function setCors(res, origin = '*') {
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Authorization, Content-Type, X-Upload-Id, X-Upload-Offset, X-Upload-Size, X-Upload-Name, X-File-Name, If-None-Match, Range',
  );
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, POST, PUT, DELETE, OPTIONS');
  res.setHeader(
    'Access-Control-Expose-Headers',
    'X-Upload-Offset, X-Upload-Size, Content-Range, Content-Disposition, Accept-Ranges, ETag',
  );
  res.setHeader('Access-Control-Max-Age', '600');
}

export function setSecurityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
}

export function json(res, status, body, extraHeaders = {}) {
  const payload = JSON.stringify(body);
  for (const [key, value] of Object.entries(extraHeaders)) res.setHeader(key, value);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

export function text(res, status, body, contentType = 'text/plain; charset=utf-8') {
  res.writeHead(status, {
    'Content-Type': contentType,
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

export function error(res, status, code, message, extra = {}) {
  json(res, status, { error: { code, message, ...extra } });
}

export function readJsonBody(req, { limit = 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(Object.assign(new Error('Request body too large'), { status: 413, code: 'body_too_large' }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(Object.assign(new Error('Invalid JSON body'), { status: 400, code: 'invalid_json' }));
      }
    });
    req.on('error', reject);
  });
}

export function bearerToken(req) {
  const header = req.headers.authorization ?? '';
  if (!header.toLowerCase().startsWith('bearer ')) return null;
  return header.slice(7).trim();
}
