import fsp from 'node:fs/promises';
import path from 'node:path';

import { describeFile } from './lib/mime.js';
import {
  PathError,
  assertValidName,
  normalizeVirtualPath,
  resolveVirtualPath,
  uniqueName,
  virtualJoin,
} from './lib/paths.js';

/**
 * A deliberately small, sandboxed "shared folder" view of the device file system.
 * In the phone app the same interface is backed by react-native-fs, with one root
 * per exposed location (Inbox, Photos, Documents…).
 */
export class FileService {
  constructor({ root }) {
    this.root = root;
  }

  async ensureRoot() {
    await fsp.mkdir(this.root, { recursive: true });
  }

  async resolve(virtualPath) {
    const { virtualPath: normal, absolutePath } = resolveVirtualPath(this.root, virtualPath);
    return { virtualPath: normal, absolutePath };
  }

  async stat(virtualPath) {
    const resolved = await this.resolve(virtualPath);
    let stat;
    try {
      stat = await fsp.stat(resolved.absolutePath);
    } catch (error) {
      if (error.code === 'ENOENT') {
        throw new PathError(`"${resolved.virtualPath}" does not exist`);
      }
      throw error;
    }
    const isDir = stat.isDirectory();
    const info = isDir ? { mime: null, kind: 'folder', inline: false, ext: '' } : describeFile(resolved.absolutePath);
    return {
      path: resolved.virtualPath,
      name: resolved.virtualPath === '/' ? '' : path.basename(resolved.virtualPath),
      type: isDir ? 'dir' : 'file',
      size: isDir ? null : stat.size,
      mtime: new Date(stat.mtimeMs).toISOString(),
      ...info,
    };
  }

  async list(virtualPath = '/', { showHidden = true } = {}) {
    const resolved = await this.resolve(virtualPath);
    let dirents;
    try {
      dirents = await fsp.readdir(resolved.absolutePath, { withFileTypes: true });
    } catch (error) {
      if (error.code === 'ENOENT') throw new PathError(`"${resolved.virtualPath}" does not exist`);
      if (error.code === 'ENOTDIR') throw new PathError(`"${resolved.virtualPath}" is not a folder`);
      throw error;
    }

    const entries = await Promise.all(
      dirents
        .filter((dirent) => showHidden || !dirent.name.startsWith('.'))
        .map(async (dirent) => {
          const childVirtual = virtualJoin(resolved.virtualPath, dirent.name);
          const childAbsolute = path.join(resolved.absolutePath, dirent.name);
          try {
            const stat = await fsp.stat(childAbsolute);
            const isDir = stat.isDirectory();
            const derived = isDir ? { mime: null, kind: 'folder', inline: false, ext: '' } : describeFile(dirent.name);
            return {
              name: dirent.name,
              path: childVirtual,
              type: isDir ? 'dir' : 'file',
              size: isDir ? null : stat.size,
              mtime: new Date(stat.mtimeMs).toISOString(),
              ...derived,
            };
          } catch {
            return null; // broken symlink / permission denied — just hide it
          }
        }),
    );

    const visible = entries.filter(Boolean);
    visible.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
      return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
    });

    return {
      path: resolved.virtualPath,
      parent: resolved.virtualPath === '/' ? null : path.posix.dirname(resolved.virtualPath),
      entries: visible,
    };
  }

  async mkdir(virtualPath) {
    const resolved = await this.resolve(virtualPath);
    if (resolved.virtualPath === '/') throw new PathError('Folder already exists');
    try {
      await fsp.mkdir(resolved.absolutePath);
    } catch (error) {
      if (error.code === 'EEXIST') throw new PathError('A file or folder with that name already exists');
      throw error;
    }
    return this.stat(resolved.virtualPath);
  }

  async remove(virtualPath) {
    const resolved = await this.resolve(virtualPath);
    if (resolved.virtualPath === '/') throw new PathError('You cannot delete the shared root');
    let stat;
    try {
      stat = await fsp.lstat(resolved.absolutePath);
    } catch (error) {
      if (error.code === 'ENOENT') throw new PathError('File not found');
      throw error;
    }
    await fsp.rm(resolved.absolutePath, { recursive: stat.isDirectory(), force: false });
    return { removed: resolved.virtualPath };
  }

  async rename(virtualPath, newName) {
    const resolved = await this.resolve(virtualPath);
    if (resolved.virtualPath === '/') throw new PathError('You cannot rename the shared root');
    assertValidName(newName);
    const target = path.join(path.dirname(resolved.absolutePath), newName);
    try {
      await fsp.access(target);
      throw new PathError('A file or folder with that name already exists');
    } catch (error) {
      if (error instanceof PathError) throw error;
      if (error.code !== 'ENOENT') throw error;
    }
    await fsp.rename(resolved.absolutePath, target);
    return this.stat(virtualJoin(path.posix.dirname(resolved.virtualPath), newName));
  }

  /** Picks an unused file name inside a folder (never overwrites silently). */
  async chooseTarget(dirVirtual, name) {
    assertValidName(name);
    const resolved = await this.resolve(dirVirtual);
    const stat = await fsp.stat(resolved.absolutePath).catch(() => null);
    if (!stat?.isDirectory()) throw new PathError('Destination folder does not exist');
    const existing = new Set(
      (await fsp.readdir(resolved.absolutePath)).map((entry) => entry.toLowerCase()),
    );
    const finalName = uniqueName(name, existing);
    return {
      name: finalName,
      virtualPath: virtualJoin(resolved.virtualPath, finalName),
      absolutePath: path.join(resolved.absolutePath, finalName),
    };
  }

  async storage() {
    try {
      const stats = await fsp.statfs(this.root);
      const total = stats.blocks * stats.bsize;
      const free = stats.bavail * stats.bsize;
      return {
        total,
        free,
        used: total - free,
        sharedBytes: await this.directorySize(this.root),
      };
    } catch {
      return { total: null, free: null, used: null, sharedBytes: await this.directorySize(this.root) };
    }
  }

  async directorySize(dir, depth = 0) {
    if (depth > 6) return 0;
    let total = 0;
    const dirents = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const dirent of dirents) {
      const child = path.join(dir, dirent.name);
      if (dirent.isDirectory()) {
        total += await this.directorySize(child, depth + 1);
      } else if (dirent.isFile()) {
        total += (await fsp.stat(child).catch(() => ({ size: 0 }))).size;
      }
    }
    return total;
  }

  /** Locations shown in the desktop sidebar. */
  async locations(definitions) {
    return Promise.all(
      definitions.map(async (definition) => {
        const resolved = await this.resolve(definition.path);
        const stat = await fsp.stat(resolved.absolutePath).catch(() => null);
        let count = 0;
        let bytes = 0;
        if (stat?.isDirectory()) {
          const dirents = await fsp.readdir(resolved.absolutePath, { withFileTypes: true }).catch(() => []);
          count = dirents.length;
          bytes = dirents.reduce((sum, dirent) => sum + (dirent.isFile() ? 0 : 0), 0);
        }
        return {
          ...definition,
          exists: Boolean(stat?.isDirectory()),
          count,
          bytes,
        };
      }),
    );
  }
}

export { normalizeVirtualPath };
