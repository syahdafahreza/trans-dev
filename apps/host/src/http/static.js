import fsp from 'node:fs/promises';
import path from 'node:path';

import { contentTypeFor, sendFile } from './stream.js';

/**
 * Serves the built dashboard when it exists, mirroring the behaviour of the phone
 * app, which serves its bundled web asset off the same LAN server.
 */
export function createStaticHandler(distDir) {
  return async function serveStatic(req, res, pathname) {
    const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
    const target = path.resolve(distDir, rel);

    if (!target.startsWith(path.resolve(distDir))) {
      res.writeHead(403).end('Forbidden');
      return true;
    }

    try {
      const stat = await fsp.stat(target);
      if (stat.isFile()) {
        const immutable = pathname.startsWith('/assets/');
        await sendFile(req, res, target, {
          mime: contentTypeFor(target),
          name: path.basename(target),
          cacheControl: immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
        });
        return true;
      }
    } catch {
      // fall through to SPA fallback
    }

    // Client-side routing: unknown paths without an extension get index.html.
    if (!path.extname(pathname)) {
      const indexPath = path.join(distDir, 'index.html');
      const exists = await fsp.stat(indexPath).catch(() => null);
      if (exists?.isFile()) {
        await sendFile(req, res, indexPath, {
          mime: contentTypeFor(indexPath),
          name: 'index.html',
          cacheControl: 'no-cache',
        });
        return true;
      }
    }
    return false;
  };
}
