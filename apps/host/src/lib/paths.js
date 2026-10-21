import path from 'node:path';

export class PathError extends Error {
  constructor(message = 'Invalid path') {
    super(message);
    this.name = 'PathError';
    this.code = 'invalid_path';
    this.status = 400;
  }
}

const MAX_SEGMENT = 255;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/**
 * Turns a client supplied path into a clean, absolute, POSIX-style virtual path.
 * Rejects traversal instead of silently normalising it, so a malformed client
 * gets a clear 400 instead of surprising behaviour.
 */
export function normalizeVirtualPath(input) {
  if (input === undefined || input === null || input === '') return '/';
  if (typeof input !== 'string') throw new PathError('Path must be a string');
  if (CONTROL_CHARS.test(input)) throw new PathError('Path contains control characters');

  const raw = input.replace(/\\/g, '/');
  if (raw.length > 4096) throw new PathError('Path is too long');

  const segments = [];
  for (const segment of raw.split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') throw new PathError('Path traversal is not allowed');
    if (segment.length > MAX_SEGMENT) throw new PathError('Path segment is too long');
    segments.push(segment);
  }
  return `/${segments.join('/')}`;
}

/** Joins a virtual path onto the shared root and proves the result stays inside it. */
export function resolveVirtualPath(root, virtualPath) {
  const normal = normalizeVirtualPath(virtualPath);
  const absolute = path.resolve(root, `.${normal}`);
  const relative = path.relative(root, absolute);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new PathError('Path escapes the shared root');
  }
  return { virtualPath: normal, absolutePath: absolute };
}

/** Rejects names that cannot be a single file-system entry. */
export function assertValidName(name) {
  if (typeof name !== 'string' || !name.trim()) throw new PathError('File name is required');
  if (name === '.' || name === '..') throw new PathError('Invalid file name');
  if (name.includes('/') || name.includes('\\')) throw new PathError('File name cannot contain slashes');
  if (CONTROL_CHARS.test(name)) throw new PathError('File name contains control characters');
  if (name.length > MAX_SEGMENT) throw new PathError('File name is too long');
  return name;
}

export function virtualJoin(parent, name) {
  const base = normalizeVirtualPath(parent);
  return base === '/' ? `/${name}` : `${base}/${name}`;
}

export function virtualDirname(virtualPath) {
  const p = normalizeVirtualPath(virtualPath);
  if (p === '/') return '/';
  const idx = p.lastIndexOf('/');
  return idx <= 0 ? '/' : p.slice(0, idx);
}

export function virtualBasename(virtualPath) {
  const p = normalizeVirtualPath(virtualPath);
  return p === '/' ? '' : p.slice(p.lastIndexOf('/') + 1);
}

/** Appends " (n)" until the name does not collide with an existing entry. */
export function uniqueName(name, taken) {
  if (!taken.has(name.toLowerCase())) return name;
  const ext = path.extname(name);
  const stem = ext ? name.slice(0, -ext.length) : name;
  for (let i = 1; i < 1000; i += 1) {
    const candidate = `${stem} (${i})${ext}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
  return `${stem}-${Date.now()}${ext}`;
}
