import type { Entry, Listing, PairInfo, PairResult, ShareLocation, StorageInfo } from './types';

export class ApiError extends Error {
  status: number;
  code: string;
  retryAfter?: number;

  constructor(message: string, status: number, code = 'error', retryAfter?: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

const SESSION_KEY = 'transdev.session';
const HOST_KEY = 'transdev.host';

export interface StoredSession {
  id: string;
  token: string;
  expiresAt: string;
  clientName: string;
  deviceName: string;
  baseUrl: string;
}

export function loadStoredSession(): StoredSession | null {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredSession;
    if (!parsed.token || !parsed.expiresAt) return null;
    if (!parsed.id) parsed.id = '';
    if (new Date(parsed.expiresAt).getTime() < Date.now() + 5000) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function saveStoredSession(session: StoredSession | null) {
  try {
    if (session) sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
    else sessionStorage.removeItem(SESSION_KEY);
  } catch {
    /* Safari private mode and storage quotas */
  }
}

export function loadStoredHost(): string | null {
  try {
    return localStorage.getItem(HOST_KEY);
  } catch {
    return null;
  }
}

export function saveStoredHost(host: string) {
  try {
    if (host) localStorage.setItem(HOST_KEY, host);
    else localStorage.removeItem(HOST_KEY);
  } catch {
    /* private mode */
  }
}

/**
 * Normalises whatever the user typed (`192.168.1.4`, `192.168.1.4:8787`,
 * `http://phone.local:8787`) into an origin we can prefix requests with.
 */
export function normalizeHost(input: string): string {
  const trimmed = input.trim().replace(/\/+$/, '');
  if (!trimmed) return '';
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `http://${trimmed}`;
}

export function currentHostFromLocation(): string {
  const params = new URLSearchParams(window.location.search);
  const explicit = params.get('host');
  if (explicit) return normalizeHost(explicit);
  return ''; // same origin — the phone serves the dashboard itself
}

function urlFor(baseUrl: string, path: string): string {
  return baseUrl ? `${baseUrl}${path}` : path;
}

export class TransClient {
  readonly baseUrl: string;
  token: string | null;

  constructor(baseUrl = '', token: string | null = null) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.token = token;
  }

  private headers(extra: Record<string, string> = {}): HeadersInit {
    return {
      ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
      ...extra,
    };
  }

  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    let response: Response;
    try {
      response = await fetch(urlFor(this.baseUrl, path), {
        ...init,
        headers: this.headers(init.headers as Record<string, string>),
      });
    } catch {
      throw new ApiError(
        'Cannot reach the phone. Check that both devices are on the same Wi-Fi and the server is running.',
        0,
        'network_error',
      );
    }
    if (!response.ok) {
      let message = `Request failed (${response.status})`;
      let code = 'http_error';
      let retryAfter: number | undefined;
      try {
        const body = await response.clone().json();
        message = body?.error?.message ?? message;
        code = body?.error?.code ?? code;
        retryAfter = body?.error?.retryAfter;
      } catch {
        /* non JSON error body */
      }
      throw new ApiError(message, response.status, code, retryAfter);
    }
    return response;
  }

  private async json<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await this.request(path, init);
    return (await response.json()) as T;
  }

  // ------------------------------------------------------------------ pairing

  static async pairInfo(baseUrl: string): Promise<PairInfo> {
    const response = await fetch(urlFor(baseUrl, '/api/pair/info'));
    if (!response.ok) throw new ApiError('Could not read pairing info from this device.', response.status);
    return (await response.json()) as PairInfo;
  }

  static async pair(
    baseUrl: string,
    body: { pin?: string; code?: string; clientName?: string },
  ): Promise<PairResult> {
    let response: Response;
    try {
      response = await fetch(urlFor(baseUrl, '/api/pair'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...body, clientName: body.clientName ?? describeBrowser() }),
      });
    } catch {
      throw new ApiError('Cannot reach the phone at that address.', 0, 'network_error');
    }
    if (!response.ok) {
      let message = 'Pairing failed';
      let code = 'pairing_failed';
      let retryAfter: number | undefined;
      try {
        const payload = await response.json();
        message = payload?.error?.message ?? message;
        code = payload?.error?.code ?? code;
        retryAfter = payload?.error?.retryAfter;
      } catch {
        /* ignore */
      }
      throw new ApiError(message, response.status, code, retryAfter);
    }
    return (await response.json()) as PairResult;
  }

  // ------------------------------------------------------------------ session

  session() {
    return this.json<{ session: { id: string; clientName: string; expiresAt: string }; device: { name: string }; locations: ShareLocation[] }>(
      '/api/session',
    );
  }

  logout() {
    return this.json<{ ok: boolean }>('/api/session/logout', { method: 'POST' });
  }

  sessions() {
    return this.json<{
      sessions: { id: string; clientName: string; ip: string; method: string; lastSeenAt: string }[];
    }>('/api/sessions');
  }

  revokeSession(id: string) {
    return this.json<{ revoked: string }>(`/api/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' });
  }

  // ---------------------------------------------------------------- file system

  locations() {
    return this.json<{ locations: ShareLocation[] }>('/api/fs/locations');
  }

  list(path: string) {
    return this.json<Listing>(`/api/fs/list?path=${encodeURIComponent(path)}`);
  }

  search(query: string, path = '/') {
    return this.json<{ query: string; results: Entry[] }>(
      `/api/fs/search?q=${encodeURIComponent(query)}&path=${encodeURIComponent(path)}`,
    );
  }

  storage() {
    return this.json<{ storage: StorageInfo }>('/api/storage');
  }

  mkdir(path: string, name: string) {
    return this.json<{ entry: Entry }>('/api/fs/mkdir', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path, name }),
    });
  }

  rename(path: string, name: string) {
    return this.json<{ entry: Entry }>('/api/fs/rename', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path, name }),
    });
  }

  remove(paths: string[]) {
    return this.json<{ removed: string[] }>('/api/fs/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths }),
    });
  }

  /** Signed URL — required because <img>/<video> cannot send the bearer token. */
  async assetUrl(path: string, mode: 'inline' | 'download' = 'inline'): Promise<string> {
    const { url } = await this.json<{ url: string }>('/api/asset', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path, mode }),
    });
    return urlFor(this.baseUrl, url);
  }

  async assetResponse(path: string): Promise<Response> {
    const url = await this.assetUrl(path);
    return fetch(url);
  }

  // -------------------------------------------------------------------- upload

  async uploadBegin(params: { uploadId: string; dir: string; name: string; size: number; signal?: AbortSignal }) {
    return this.json<{ uploadId: string; offset: number; size: number; path: string }>('/api/upload', {
      method: 'PUT',
      signal: params.signal,
      headers: {
        'X-Upload-Id': params.uploadId,
        'X-Upload-Dir': encodeURIComponent(params.dir),
        'X-Upload-Name': encodeURIComponent(params.name),
        'X-Upload-Size': String(params.size),
      },
    });
  }

  async uploadChunk(params: {
    uploadId: string;
    offset: number;
    chunk: Blob;
    signal?: AbortSignal;
  }) {
    return this.json<{ offset: number; size: number; complete: boolean }>('/api/upload', {
      method: 'PUT',
      signal: params.signal,
      headers: {
        'X-Upload-Id': params.uploadId,
        'X-Upload-Offset': String(params.offset),
        'Content-Type': 'application/octet-stream',
      },
      body: params.chunk,
    });
  }

  async uploadStatus(uploadId: string) {
    return this.json<{ offset: number; size: number | null; complete: boolean }>(
      `/api/upload?id=${encodeURIComponent(uploadId)}`,
    );
  }

  async uploadFinish(uploadId: string) {
    return this.json<{ entry: Entry }>('/api/upload/finish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uploadId }),
    });
  }

  async uploadAbort(uploadId: string) {
    return this.request(`/api/upload/${encodeURIComponent(uploadId)}`, { method: 'DELETE' });
  }

  // ------------------------------------------------------------------- events

  eventStream(onEvent: (event: string, data: unknown) => void): () => void {
    if (!this.token) return () => {};
    const query = new URLSearchParams({ token: this.token });
    const source = new EventSource(urlFor(this.baseUrl, `/api/events?${query.toString()}`));
    const types = ['fs', 'pairing'];
    for (const type of types) {
      source.addEventListener(type, (event) => {
        try {
          onEvent(type, JSON.parse((event as MessageEvent).data));
        } catch {
          /* ignore malformed frame */
        }
      });
    }
    return () => source.close();
  }
}

export function describeBrowser(): string {
  const ua = navigator.userAgent;
  const os = /Windows/.test(ua)
    ? 'Windows'
    : /Mac OS/.test(ua)
      ? 'macOS'
      : /Android/.test(ua)
        ? 'Android'
        : /iPhone|iPad/.test(ua)
          ? 'iOS'
          : /Linux/.test(ua)
            ? 'Linux'
            : 'Desktop';
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /Firefox\//.test(ua)
      ? 'Firefox'
      : /Chrome\//.test(ua)
        ? 'Chrome'
        : /Safari\//.test(ua)
          ? 'Safari'
          : 'Browser';
  return `${browser} on ${os}`;
}
