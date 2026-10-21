import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const DEFAULT_TTL_MS = 10 * 60 * 1000;

/**
 * Short-lived signed URLs.
 *
 * `<img>`, `<video>` and `<a download>` cannot send an Authorization header, so the
 * dashboard asks for a signed URL per file instead of putting the session token in a
 * query string. A signature is bound to one path, one mode and one expiry.
 */
export class AssetSigner {
  constructor(secret = randomBytes(32), { ttlMs = DEFAULT_TTL_MS } = {}) {
    this.secret = secret;
    this.ttlMs = ttlMs;
  }

  payload({ sessionId, path, mode, exp }) {
    return `${sessionId}\n${path}\n${mode}\n${exp}`;
  }

  sign({ sessionId, path, mode = 'inline', ttlMs = this.ttlMs }) {
    const exp = Date.now() + ttlMs;
    const signature = createHmac('sha256', this.secret)
      .update(this.payload({ sessionId, path, mode, exp }))
      .digest('base64url');
    return { exp, signature };
  }

  verify({ sessionId, path, mode = 'inline', exp, signature }) {
    if (!sessionId || !path || !exp || !signature) return false;
    if (Number(exp) < Date.now()) return false;
    const expected = createHmac('sha256', this.secret)
      .update(this.payload({ sessionId, path, mode, exp: Number(exp) }))
      .digest('base64url');
    const a = Buffer.from(String(expected));
    const b = Buffer.from(String(signature));
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  }

  urlFor({ sessionId, path, mode = 'inline', downloadName }) {
    const { exp, signature } = this.sign({ sessionId, path, mode });
    const params = new URLSearchParams({ path, mode, exp: String(exp), sig: signature, s: sessionId });
    if (downloadName) params.set('name', downloadName);
    return `/api/asset?${params.toString()}`;
  }
}
