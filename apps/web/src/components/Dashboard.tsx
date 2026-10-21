import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { ApiError, type StoredSession, type TransClient } from '../lib/api';
import { formatBytes, percent, relativeTime } from '../lib/format';
import type { IncomingFile, ShareLocation, StorageInfo, TransferItem } from '../lib/types';
import { Uploader } from '../lib/uploader';
import { FileBrowser } from './FileBrowser';
import { Icon } from './Icon';
import { Transfers } from './Transfers';
import { Button, Modal, type Toast } from './ui';

interface DashboardProps {
  client: TransClient;
  session: StoredSession;
  locations: ShareLocation[];
  notify: (toast: Omit<Toast, 'id'>) => void;
  onDisconnect: () => void;
}

const locationIcons: Record<string, string> = {
  inbox: 'inbox',
  image: 'image',
  document: 'file-text',
  download: 'download',
  folder: 'folder',
};

export function Dashboard({ client, session, locations, notify, onDisconnect }: DashboardProps) {
  const [path, setPath] = useState('/Inbox');
  const [refreshKey, setRefreshKey] = useState(0);
  const [storage, setStorage] = useState<StorageInfo | null>(null);
  const [places, setPlaces] = useState<ShareLocation[]>(locations);
  const [transfers, setTransfers] = useState<TransferItem[]>([]);
  const [devicesOpen, setDevicesOpen] = useState(false);
  const [sessions, setSessions] = useState<{ id: string; clientName: string; ip: string; method: string; lastSeenAt: string }[]>([]);
  const [sessionBusy, setSessionBusy] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const uploader = useMemo(() => new Uploader(client), [client]);
  const activeCountRef = useRef(0);
  const refreshTimer = useRef<number | null>(null);

  const bumpRefresh = useCallback(() => {
    if (refreshTimer.current) window.clearTimeout(refreshTimer.current);
    refreshTimer.current = window.setTimeout(() => setRefreshKey((key) => key + 1), 250);
  }, []);

  const loadStorage = useCallback(() => {
    client
      .storage()
      .then((payload) => setStorage(payload.storage))
      .catch(() => {});
  }, [client]);

  const loadPlaces = useCallback(() => {
    client
      .locations()
      .then((payload) => setPlaces(payload.locations))
      .catch(() => {});
  }, [client]);

  useEffect(() => {
    loadStorage();
    loadPlaces();
  }, [loadPlaces, loadStorage]);

  useEffect(() => {
    const unsubscribe = uploader.subscribe((items) => {
      setTransfers(items);
      const active = items.filter((item) => ['queued', 'uploading', 'finishing'].includes(item.status)).length;
      if (activeCountRef.current > 0 && active === 0) {
        const failed = items.filter((item) => item.status === 'error').length;
        const done = items.filter((item) => item.status === 'done').length;
        if (done > 0 && failed === 0) {
          notify({ tone: 'success', title: 'Upload complete', message: `${done} ${done === 1 ? 'file' : 'files'} saved to your phone.` });
        } else if (failed > 0) {
          notify({ tone: 'error', title: 'Some uploads failed', message: 'Open Transfers to retry.' });
        }
        bumpRefresh();
        loadStorage();
        loadPlaces();
      }
      activeCountRef.current = active;
    });
    return unsubscribe;
  }, [bumpRefresh, loadPlaces, loadStorage, notify, uploader]);

  // Live updates: another paired device (or the phone itself) changed the folder.
  useEffect(() => {
    return client.eventStream((event, data) => {
      if (event === 'fs') {
        bumpRefresh();
        loadStorage();
      }
      if (event === 'pairing') {
        const payload = data as { type?: string };
        if (payload?.type === 'paired') {
          notify({ tone: 'info', title: 'New device paired', message: 'You can review sessions under Devices.' });
        }
      }
    });
  }, [bumpRefresh, client, loadStorage, notify]);

  useEffect(() => {
    return () => {
      if (refreshTimer.current) window.clearTimeout(refreshTimer.current);
    };
  }, []);

  const ensureFolders = useCallback(
    async (dirs: string[]) => {
      const sorted = [...new Set(dirs)].sort((a, b) => a.length - b.length);
      for (const dir of sorted) {
        const segments = dir.split('/').filter(Boolean);
        let current = '';
        for (const segment of segments) {
          const next = `${current}/${segment}`;
          current = next;
          try {
            await client.mkdir(current.slice(0, current.lastIndexOf('/')) || '/', segment);
          } catch {
            // exists already (or the parent was just created) — keep going
          }
        }
      }
    },
    [client],
  );

  const handleUpload = useCallback(
    (incoming: IncomingFile[]) => {
      if (!incoming.length) return;
      const groups = new Map<string, File[]>();
      for (const item of incoming) {
        const parts = item.relativePath.split('/').filter(Boolean);
        const name = parts.pop() ?? item.file.name;
        const relativeDir = parts.join('/');
        const dir = relativeDir ? `${path === '/' ? '' : path}/${relativeDir}` : path;
        const named = name === item.file.name ? item.file : new File([item.file], name, { type: item.file.type });
        if (!groups.has(dir)) groups.set(dir, []);
        groups.get(dir)!.push(named);
      }

      void (async () => {
        try {
          const nested = [...groups.keys()].filter((dir) => dir !== path);
          if (nested.length) await ensureFolders(nested);
        } catch {
          /* folder creation is best effort; the upload will surface a real error */
        }
        for (const [dir, files] of groups) uploader.enqueue(files, dir);
      })();
    },
    [ensureFolders, path, uploader],
  );

  const openDevices = useCallback(async () => {
    setDevicesOpen(true);
    try {
      const payload = await client.sessions();
      setSessions(payload.sessions);
    } catch (exception) {
      notify({ tone: 'error', title: 'Could not load sessions', message: (exception as Error).message });
    }
  }, [client, notify]);

  const revoke = useCallback(
    async (id: string) => {
      setSessionBusy(id);
      try {
        await client.revokeSession(id);
        setSessions((current) => current.filter((candidate) => candidate.id !== id));
        if (id === session.id) {
          onDisconnect();
          return;
        }
        notify({ tone: 'success', title: 'Device disconnected' });
      } catch (exception) {
        notify({ tone: 'error', title: 'Could not disconnect device', message: (exception as Error).message });
      } finally {
        setSessionBusy(null);
      }
    },
    [client, notify, onDisconnect, session.id],
  );

  const disconnect = useCallback(async () => {
    try {
      await client.logout();
    } catch (exception) {
      if (!(exception instanceof ApiError) || exception.status !== 401) {
        notify({ tone: 'error', title: 'Sign out failed', message: (exception as Error).message });
      }
    }
    onDisconnect();
  }, [client, notify, onDisconnect]);

  const activeLocation = places.find(
    (place) => path === place.path || path.startsWith(`${place.path}/`),
  );
  const usedPercent = storage?.total ? percent(storage.used ?? 0, storage.total) : 0;
  const urlHost = session.baseUrl ? session.baseUrl.replace(/^https?:\/\//, '') : window.location.host;

  return (
    <div className="app">
      <header className="topbar">
        <button
          className="icon-btn topbar__menu"
          aria-label="Toggle folders"
          onClick={() => setSidebarOpen((value) => !value)}
        >
          <Icon name="list" size={18} />
        </button>

        <div className="brand">
          <span className="brand__mark">
            <Icon name="zap" size={16} />
          </span>
          <span className="brand__name">TransDev</span>
          <span className="brand__tag">Local</span>
        </div>

        <button className="conn-chip" onClick={() => void openDevices()} title="Manage connected devices">
          <span className="status-dot status-dot--on" />
          <span className="conn-chip__text">
            <strong>{session.deviceName}</strong>
            <span>{urlHost}</span>
          </span>
          <Icon name="chevron-down" size={14} />
        </button>

        <div className="topbar__spacer" />

        <div className="storage-mini" title="Phone storage">
          <span className="storage-mini__label">Phone storage</span>
          <span className="storage-mini__value">
            {storage ? `${formatBytes((storage.total ?? 0) - (storage.free ?? 0))} of ${formatBytes(storage.total)}` : '—'}
          </span>
          <span className="storage-mini__bar">
            <span style={{ width: `${usedPercent}%` }} />
          </span>
        </div>

        <button className="icon-btn" onClick={() => void openDevices()} aria-label="Connected devices">
          <Icon name="users" size={18} />
        </button>
        <Button variant="secondary" size="sm" icon="logout" onClick={() => void disconnect()} className="hide-sm">
          Disconnect
        </Button>
        <button className="icon-btn hide-lg" onClick={() => void disconnect()} aria-label="Disconnect">
          <Icon name="logout" size={18} />
        </button>
      </header>

      <div className="shell">
        <aside className={`sidebar ${sidebarOpen ? 'is-open' : ''}`}>
          <div className="sidebar__section">
            <span className="sidebar__label">This phone</span>
            <nav className="places">
              <button
                className={`place ${path === '/' ? 'is-active' : ''}`}
                onClick={() => {
                  setPath('/');
                  setSidebarOpen(false);
                }}
              >
                <span className="place__icon">
                  <Icon name="grid" size={16} />
                </span>
                All files
              </button>
              {places.map((place) => {
                const active = activeLocation?.id === place.id;
                return (
                  <button
                    key={place.id}
                    className={`place ${active ? 'is-active' : ''}`}
                    onClick={() => {
                      setPath(place.path);
                      setSidebarOpen(false);
                    }}
                    title={place.hint}
                  >
                    <span className="place__icon">
                      <Icon name={locationIcons[place.icon] ?? 'folder'} size={16} />
                    </span>
                    <span className="place__label">{place.label}</span>
                    {typeof place.count === 'number' && place.count > 0 && (
                      <span className="place__count">{place.count}</span>
                    )}
                  </button>
                );
              })}
            </nav>
          </div>

          {storage && (
            <div className="storage-card">
              <div className="storage-card__head">
                <span>
                  <Icon name="phone" size={14} /> Device storage
                </span>
                <strong>{Math.round(usedPercent)}% used</strong>
              </div>
              <div className="storage-card__bar">
                <span style={{ width: `${usedPercent}%` }} />
              </div>
              <div className="storage-card__rows">
                <div>
                  <span>Free</span>
                  <strong>{formatBytes(storage.free)}</strong>
                </div>
                <div>
                  <span>Total</span>
                  <strong>{formatBytes(storage.total)}</strong>
                </div>
                <div>
                  <span>Shared</span>
                  <strong>{formatBytes(storage.sharedBytes)}</strong>
                </div>
              </div>
            </div>
          )}

          <div className="session-card">
            <span className="session-card__label">
              <Icon name="lock" size={13} /> This session
            </span>
            <strong>{session.clientName}</strong>
            <span className="session-card__meta">
              Paired via PIN · expires {relativeTime(session.expiresAt)}
            </span>
            <button className="link-btn" onClick={() => void openDevices()}>
              Manage devices
            </button>
          </div>

          <div className="sidebar__tip">
            <Icon name="shield" size={15} />
            <p>
              Files stay on your local network. Nothing is uploaded to a server, and every byte is authorised by this
              session.
            </p>
          </div>
        </aside>

        {sidebarOpen && <div className="sidebar__scrim" onClick={() => setSidebarOpen(false)} />}

        <main className="main">
          <FileBrowser
            client={client}
            path={path}
            onNavigate={setPath}
            refreshKey={refreshKey}
            onUpload={handleUpload}
            notify={notify}
            onChanged={() => {
              loadStorage();
              loadPlaces();
            }}
          />
        </main>
      </div>

      <Transfers
        items={transfers}
        onCancel={(id) => uploader.cancel(id)}
        onRetry={(id) => uploader.retry(id)}
        onClear={() => uploader.clearFinished()}
      />

      <Modal
        open={devicesOpen}
        title="Connected devices"
        subtitle="Every session can read and write files on this phone. Disconnect anything you do not recognise."
        onClose={() => setDevicesOpen(false)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setDevicesOpen(false)}>
              Close
            </Button>
            <Button variant="danger" icon="logout" onClick={() => void disconnect()}>
              Disconnect this browser
            </Button>
          </>
        }
      >
        <ul className="session-list">
          <li className="session-item session-item--current">
            <span className="session-item__icon">
              <Icon name="monitor" size={18} />
            </span>
            <div className="session-item__body">
              <strong>
                {session.clientName}
                <span className="pill pill--success">This browser</span>
              </strong>
              <span>Paired via PIN · active now</span>
            </div>
          </li>
          {sessions
            .filter((candidate) => candidate.id !== session.id)
            .map((candidate) => (
              <li className="session-item" key={candidate.id}>
                <span className="session-item__icon">
                  <Icon name="monitor" size={18} />
                </span>
                <div className="session-item__body">
                  <strong>{candidate.clientName}</strong>
                  <span>
                    {candidate.ip} · via {candidate.method.toUpperCase()} · seen {relativeTime(candidate.lastSeenAt)}
                  </span>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => void revoke(candidate.id)}
                  loading={sessionBusy === candidate.id}
                >
                  Revoke
                </Button>
              </li>
            ))}
        </ul>
      </Modal>
    </div>
  );
}
