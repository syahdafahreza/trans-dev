import type { PublicSession } from './server/pairing';

export interface StorageSummary {
  total: number | null;
  free: number | null;
  used: number | null;
  sharedBytes: number;
}

export interface FileEntry {
  name: string;
  path: string;
  type: 'dir' | 'file';
  size: number | null;
  mtime: string;
  ext: string;
  mime: string | null;
  kind: string;
  inline: boolean;
}

export interface HostSnapshot {
  running: boolean;
  ip: string;
  port: number;
  pin: string;
  deviceName: string;
  connections: number;
  sessions: PublicSession[];
  lastError: string | null;
  storage: StorageSummary;
}

export function formatBytes(bytes: number | null | undefined) {
  if (!bytes || bytes < 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** exponent;
  return `${value.toFixed(exponent === 0 ? 0 : value >= 100 ? 0 : 1)} ${units[exponent]}`;
}

export function relativeTime(iso: string) {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const seconds = Math.round((then - Date.now()) / 1000);
  const abs = Math.abs(seconds);
  if (abs < 60) return 'just now';
  if (abs < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (abs < 86_400) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86_400)}d ago`;
}
