import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function bool(value, fallback = false) {
  if (value === undefined) return fallback;
  return /^(1|true|yes|on)$/i.test(String(value));
}

/**
 * Resolves runtime configuration. Every value can be overridden with env vars so the
 * server runs the same way on a laptop, in CI and on a phone (via its RN port).
 */
export function loadConfig(env = process.env) {
  const root = path.resolve(env.ROOT ?? path.join(packageRoot, 'data'));
  const tmpDir = path.resolve(env.TMP_DIR ?? path.join(packageRoot, '.uploads'));

  return {
    packageRoot,
    host: env.HOST ?? '0.0.0.0',
    port: Number(env.PORT ?? 8787),
    root,
    tmpDir,
    deviceName: env.DEVICE_NAME ?? 'Pixel 8 · TransDev',
    pin: env.PIN ?? null,
    publicUrl: env.PUBLIC_URL ?? null,
    demo: bool(env.DEMO, true),
    maxUploadBytes: Number(env.MAX_UPLOAD_BYTES ?? 20 * 1024 * 1024 * 1024),
    sessionTtlMs: Number(env.SESSION_TTL_MS ?? 12 * 60 * 60 * 1000),
    webDist: path.resolve(env.WEB_DIST ?? path.join(packageRoot, '..', 'web', 'dist')),
    logRequests: bool(env.LOG_REQUESTS, true),
  };
}

export { packageRoot };
