export type EntryKind =
  | 'folder'
  | 'image'
  | 'video'
  | 'audio'
  | 'pdf'
  | 'document'
  | 'spreadsheet'
  | 'presentation'
  | 'text'
  | 'code'
  | 'archive'
  | 'app'
  | 'contact'
  | 'file';

export interface Entry {
  name: string;
  path: string;
  type: 'dir' | 'file';
  size: number | null;
  mtime: string;
  ext: string;
  mime: string | null;
  kind: EntryKind;
  inline: boolean;
}

export interface Listing {
  path: string;
  parent: string | null;
  entries: Entry[];
}

export interface StorageInfo {
  total: number | null;
  free: number | null;
  used: number | null;
  sharedBytes: number;
}

export interface ShareLocation {
  id: string;
  label: string;
  path: string;
  icon: string;
  hint?: string;
  exists?: boolean;
  count?: number;
}

export interface DeviceInfo {
  name: string;
  baseUrl: string;
  network?: { address: string; port: number };
}

export interface SessionInfo {
  id: string;
  clientName: string;
  method: 'pin' | 'qr';
  createdAt: string;
  expiresAt: string;
}

export interface PairResult {
  token: string;
  expiresAt: string;
  session: SessionInfo;
  device: DeviceInfo;
  locations: ShareLocation[];
  permissions: { read: boolean; write: boolean; delete: boolean };
}

export interface PairInfo {
  deviceName: string;
  baseUrl: string;
  pin?: string;
  demo?: boolean;
  qrCode?: string;
  qrExpiresAt?: string;
  pairingUrl?: string;
  network: { address: string; port: number };
  addresses: { name: string; address: string }[];
  sessionCount?: number;
}

export interface TransferItem {
  id: string;
  name: string;
  size: number;
  dir: string;
  sent: number;
  status: 'queued' | 'uploading' | 'finishing' | 'done' | 'error' | 'canceled';
  error?: string;
  startedAt: number;
  finishedAt?: number;
  speed: number;
  attempt: number;
}

/** A file picked from the OS, plus the folder path it came from (for folder drops). */
export interface IncomingFile {
  file: File;
  relativePath: string;
}
