import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { ApiError, type TransClient } from '../lib/api';
import { downloadFile, useAssetUrl } from '../lib/assets';
import { formatBytes, pluralize, relativeTime } from '../lib/format';
import type { Entry, IncomingFile, Listing } from '../lib/types';
import { Icon } from './Icon';
import { Preview } from './Preview';
import { Button, ConfirmDialog, EmptyState, KindGlyph, Modal, type Toast } from './ui';

type ViewMode = 'grid' | 'list';
type SortKey = 'name' | 'size' | 'modified' | 'kind';

interface FileBrowserProps {
  client: TransClient;
  path: string;
  onNavigate: (path: string) => void;
  refreshKey: number;
  onUpload: (files: IncomingFile[]) => void;
  notify: (toast: Omit<Toast, 'id'>) => void;
  onChanged: () => void;
}

interface MenuState {
  entry: Entry | null;
  x: number;
  y: number;
}

const VIEW_KEY = 'transdev.view';
const SORT_KEY = 'transdev.sort';

function readPreference<T extends string>(key: string, allowed: T[], fallback: T): T {
  try {
    const value = localStorage.getItem(key);
    return allowed.includes(value as T) ? (value as T) : fallback;
  } catch {
    return fallback;
  }
}

function sortEntries(entries: Entry[], key: SortKey, direction: 'asc' | 'desc'): Entry[] {
  const factor = direction === 'asc' ? 1 : -1;
  return [...entries].sort((a, b) => {
    if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
    switch (key) {
      case 'size':
        return ((a.size ?? -1) - (b.size ?? -1)) * factor;
      case 'modified':
        return (new Date(a.mtime).getTime() - new Date(b.mtime).getTime()) * factor;
      case 'kind':
        return a.kind.localeCompare(b.kind) * factor || a.name.localeCompare(b.name) * factor;
      default:
        return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }) * factor;
    }
  });
}

function parentOf(path: string): string {
  if (path === '/') return '/';
  const index = path.lastIndexOf('/');
  return index <= 0 ? '/' : path.slice(0, index);
}

function collectEntryFiles(entry: FileSystemEntry): Promise<IncomingFile[]> {
  return new Promise((resolve) => {
    if (entry.isFile) {
      (entry as FileSystemFileEntry).file(
        (file) => resolve([{ file, relativePath: entry.fullPath.replace(/^\/+/, '') || file.name }]),
        () => resolve([]),
      );
      return;
    }
    if (!entry.isDirectory) return resolve([]);
    const reader = (entry as FileSystemDirectoryEntry).createReader();
    const collected: IncomingFile[] = [];
    const readBatch = () => {
      reader.readEntries(
        async (batch) => {
          if (!batch.length) {
            resolve(collected);
            return;
          }
          for (const child of batch) {
            collected.push(...(await collectEntryFiles(child)));
          }
          readBatch();
        },
        () => resolve(collected),
      );
    };
    readBatch();
  });
}

function fileRelativePath(file: File): string {
  const relative = (file as File & { webkitRelativePath?: string }).webkitRelativePath;
  return relative || file.name;
}

async function filesFromDrop(dataTransfer: DataTransfer): Promise<IncomingFile[]> {
  const items = Array.from(dataTransfer.items ?? []);
  const supportsEntries = items.some(
    (item) => typeof (item as DataTransferItem & { webkitGetAsEntry?: unknown }).webkitGetAsEntry === 'function',
  );

  if (supportsEntries) {
    const entries = items
      .map((item) => (item as DataTransferItem & { webkitGetAsEntry?: () => FileSystemEntry | null }).webkitGetAsEntry?.())
      .filter((entry): entry is FileSystemEntry => Boolean(entry));
    if (entries.length) {
      return (await Promise.all(entries.map((entry) => collectEntryFiles(entry)))).flat();
    }
  }
  return Array.from(dataTransfer.files ?? []).map((file) => ({ file, relativePath: fileRelativePath(file) }));
}

function Thumb({ entry, client }: { entry: Entry; client: TransClient }) {
  const isImage = entry.kind === 'image';
  const { url } = useAssetUrl(client, entry.path, 'inline', isImage);
  const isVideo = entry.kind === 'video';

  if (isImage && url) {
    return (
      <div className="thumb thumb--image">
        <img src={url} alt="" loading="lazy" decoding="async" draggable={false} />
      </div>
    );
  }

  return (
    <div className={`thumb thumb--${entry.kind}`}>
      <KindGlyph entry={entry} size={54} />
      {isVideo && (
        <span className="thumb__play">
          <Icon name="video" size={14} />
        </span>
      )}
    </div>
  );
}

export function FileBrowser({
  client,
  path,
  onNavigate,
  refreshKey,
  onUpload,
  notify,
  onChanged,
}: FileBrowserProps) {
  const [previewEntry, setPreviewEntry] = useState<Entry | null>(null);
  const [listing, setListing] = useState<Listing | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [view, setView] = useState<ViewMode>(() => readPreference(VIEW_KEY, ['grid', 'list'], 'grid'));
  const [sort, setSort] = useState<{ key: SortKey; dir: 'asc' | 'desc' }>(() => {
    try {
      const stored = JSON.parse(localStorage.getItem(SORT_KEY) ?? 'null');
      if (stored && typeof stored.key === 'string') return stored;
    } catch {
      /* ignore */
    }
    return { key: 'name', dir: 'asc' };
  });
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Entry[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [selection, setSelection] = useState<Set<string>>(new Set());
  const [lastSelected, setLastSelected] = useState<string | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [creating, setCreating] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [renameTarget, setRenameTarget] = useState<Entry | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [deleteTargets, setDeleteTargets] = useState<Entry[]>([]);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);
  const fileInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  const [uploadMenu, setUploadMenu] = useState(false);
  const [navState, setNavState] = useState({ back: false, forward: false });
  const historyRef = useRef<string[]>([path]);
  const indexRef = useRef(0);

  useEffect(() => {
    try {
      localStorage.setItem(VIEW_KEY, view);
    } catch {
      /* ignore */
    }
  }, [view]);

  useEffect(() => {
    try {
      localStorage.setItem(SORT_KEY, JSON.stringify(sort));
    } catch {
      /* ignore */
    }
  }, [sort]);

  // Breadcrumb back / forward history.
  useEffect(() => {
    const history = historyRef.current;
    if (history[indexRef.current] !== path) {
      if (history[indexRef.current - 1] === path) indexRef.current -= 1;
      else if (history[indexRef.current + 1] === path) indexRef.current += 1;
      else {
        history.splice(indexRef.current + 1);
        history.push(path);
        indexRef.current = history.length - 1;
      }
    }
    setNavState({ back: indexRef.current > 0, forward: indexRef.current < history.length - 1 });
    setSelection(new Set());
    setMenu(null);
  }, [path]);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const payload = await client.list(path);
      setListing(payload);
    } catch (exception) {
      const apiError = exception instanceof ApiError ? exception : null;
      if (apiError?.status === 401) {
        setLoadError('Your session expired. Reconnect to the phone to continue.');
      } else {
        setLoadError(apiError?.message ?? 'Could not read this folder.');
      }
      setListing(null);
    } finally {
      setLoading(false);
    }
  }, [client, path]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  // Debounced server-side search across the shared tree.
  useEffect(() => {
    const term = query.trim();
    if (term.length < 2) {
      setResults(null);
      setSearching(false);
      return;
    }
    setSearching(true);
    const timer = window.setTimeout(() => {
      client
        .search(term, '/')
        .then((payload) => setResults(payload.results))
        .catch(() => setResults([]))
        .finally(() => setSearching(false));
    }, 260);
    return () => window.clearTimeout(timer);
  }, [client, query, refreshKey]);

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    window.addEventListener('mousedown', close);
    window.addEventListener('resize', close);
    window.addEventListener('scroll', close, true);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('resize', close);
      window.removeEventListener('scroll', close, true);
    };
  }, [menu]);

  const entries = useMemo(() => {
    if (!listing) return [];
    return sortEntries(listing.entries, sort.key, sort.dir);
  }, [listing, sort]);

  const displayEntries = results ?? entries;
  const selectedEntries = useMemo(
    () => displayEntries.filter((entry) => selection.has(entry.path)),
    [displayEntries, selection],
  );

  const navigate = useCallback(
    (next: string) => {
      setQuery('');
      setResults(null);
      onNavigate(next);
    },
    [onNavigate],
  );

  const handleClick = useCallback(
    (entry: Entry, event: React.MouseEvent) => {
      if (event.shiftKey && lastSelected) {
        const paths = displayEntries.map((candidate) => candidate.path);
        const from = paths.indexOf(lastSelected);
        const to = paths.indexOf(entry.path);
        if (from !== -1 && to !== -1) {
          const range = paths.slice(Math.min(from, to), Math.max(from, to) + 1);
          setSelection((current) => new Set([...current, ...range]));
          return;
        }
      }
      if (event.metaKey || event.ctrlKey) {
        setSelection((current) => {
          const next = new Set(current);
          if (next.has(entry.path)) next.delete(entry.path);
          else next.add(entry.path);
          return next;
        });
        setLastSelected(entry.path);
        return;
      }
      if (entry.type === 'dir') {
        navigate(entry.path);
        return;
      }
      setSelection(new Set([entry.path]));
      setLastSelected(entry.path);
    },
    [displayEntries, lastSelected, navigate],
  );

  const openEntry = useCallback(
    (entry: Entry) => {
      if (entry.type === 'dir') navigate(entry.path);
      else setPreviewEntry(entry);
    },
    [navigate],
  );

  const removeEntries = useCallback(
    async (targets: Entry[]) => {
      if (!targets.length) return;
      setBusy(true);
      try {
        await client.remove(targets.map((entry) => entry.path));
        notify({
          tone: 'success',
          title: targets.length === 1 ? 'Deleted' : `${targets.length} items deleted`,
          message: targets.length === 1 ? targets[0].name : 'Removed from the phone.',
        });
        setSelection(new Set());
        setDeleteTargets([]);
        await load();
        onChanged();
      } catch (exception) {
        notify({
          tone: 'error',
          title: 'Delete failed',
          message: exception instanceof Error ? exception.message : undefined,
        });
      } finally {
        setBusy(false);
      }
    },
    [client, load, notify, onChanged],
  );

  const createFolder = useCallback(async () => {
    const name = newFolderName.trim();
    if (!name) return;
    setBusy(true);
    try {
      await client.mkdir(path, name);
      setCreating(false);
      setNewFolderName('');
      await load();
      notify({ tone: 'success', title: 'Folder created', message: name });
    } catch (exception) {
      notify({ tone: 'error', title: 'Could not create folder', message: (exception as Error).message });
    } finally {
      setBusy(false);
    }
  }, [client, load, newFolderName, notify, path]);

  const rename = useCallback(async () => {
    if (!renameTarget) return;
    const name = renameValue.trim();
    if (!name || name === renameTarget.name) {
      setRenameTarget(null);
      return;
    }
    setBusy(true);
    try {
      await client.rename(renameTarget.path, name);
      setRenameTarget(null);
      await load();
      notify({ tone: 'success', title: 'Renamed', message: `${renameTarget.name} → ${name}` });
    } catch (exception) {
      notify({ tone: 'error', title: 'Rename failed', message: (exception as Error).message });
    } finally {
      setBusy(false);
    }
  }, [client, load, notify, renameTarget, renameValue]);

  const download = useCallback(
    async (targets: Entry[]) => {
      const files = targets.filter((entry) => entry.type === 'file');
      if (!files.length) return;
      try {
        for (const [index, entry] of files.entries()) {
          if (index > 0) await new Promise((resolve) => setTimeout(resolve, 350));
          await downloadFile(client, entry.path, entry.name);
        }
        notify({ tone: 'success', title: 'Download started', message: pluralize(files.length, 'file') });
      } catch (exception) {
        notify({ tone: 'error', title: 'Download failed', message: (exception as Error).message });
      }
    },
    [client, notify],
  );

  const handleDrop = useCallback(
    async (event: React.DragEvent) => {
      event.preventDefault();
      dragDepth.current = 0;
      setDragging(false);
      if (!event.dataTransfer) return;
      const files = await filesFromDrop(event.dataTransfer);
      if (files.length) onUpload(files);
      else notify({ tone: 'error', title: 'Nothing to upload', message: 'Those items could not be read.' });
    },
    [notify, onUpload],
  );

  const guardedUploadFromInput = useCallback(
    (input: HTMLInputElement | null) => {
      if (input?.files?.length) {
        onUpload(Array.from(input.files).map((file) => ({ file, relativePath: fileRelativePath(file) })));
      }
      if (input) input.value = '';
    },
    [onUpload],
  );

  const selectionCount = selection.size;
  const searchMode = Boolean(results) || query.trim().length >= 2;

  return (
    <div
      className="browser"
      onClick={(event) => {
        if (event.target === event.currentTarget) setSelection(new Set());
      }}
      onDragEnter={(event) => {
        if (!Array.from(event.dataTransfer?.types ?? []).includes('Files')) return;
        dragDepth.current += 1;
        setDragging(true);
      }}
      onDragOver={(event) => {
        if (Array.from(event.dataTransfer?.types ?? []).includes('Files')) {
          event.preventDefault();
          event.dataTransfer.dropEffect = 'copy';
        }
      }}
      onDragLeave={() => {
        dragDepth.current = Math.max(0, dragDepth.current - 1);
        if (dragDepth.current === 0) setDragging(false);
      }}
      onDrop={(event) => void handleDrop(event)}
    >
      <div className="toolbar">
        <div className="toolbar__nav">
          <button
            className="icon-btn"
            aria-label="Back"
            disabled={!navState.back}
            onClick={() => onNavigate(historyRef.current[indexRef.current - 1])}
          >
            <Icon name="chevron-left" size={18} />
          </button>
          <button
            className="icon-btn"
            aria-label="Forward"
            disabled={!navState.forward}
            onClick={() => onNavigate(historyRef.current[indexRef.current + 1])}
          >
            <Icon name="chevron-right" size={18} />
          </button>
          <button
            className="icon-btn"
            aria-label="Up one folder"
            disabled={path === '/'}
            onClick={() => onNavigate(parentOf(path))}
          >
            <Icon name="arrow-left" size={18} />
          </button>
        </div>

        <label className="search">
          <Icon name="search" size={16} />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search this device"
            aria-label="Search files"
          />
          {query && (
            <button className="icon-btn icon-btn--xs" onClick={() => setQuery('')} aria-label="Clear search">
              <Icon name="x" size={14} />
            </button>
          )}
        </label>

        <div className="toolbar__spacer" />

        <div className="segmented" role="group" aria-label="View mode">
          <button
            className={view === 'grid' ? 'is-active' : ''}
            onClick={() => setView('grid')}
            aria-pressed={view === 'grid'}
            aria-label="Grid view"
          >
            <Icon name="grid" size={16} />
          </button>
          <button
            className={view === 'list' ? 'is-active' : ''}
            onClick={() => setView('list')}
            aria-pressed={view === 'list'}
            aria-label="List view"
          >
            <Icon name="list" size={16} />
          </button>
        </div>

        <div className="sort">
          <Icon name="sort" size={15} />
          <select
            value={`${sort.key}:${sort.dir}`}
            onChange={(event) => {
              const [key, dir] = event.target.value.split(':') as [SortKey, 'asc' | 'desc'];
              setSort({ key, dir });
            }}
            aria-label="Sort files"
          >
            <option value="name:asc">Name A–Z</option>
            <option value="name:desc">Name Z–A</option>
            <option value="modified:desc">Newest first</option>
            <option value="modified:asc">Oldest first</option>
            <option value="size:desc">Largest first</option>
            <option value="size:asc">Smallest first</option>
            <option value="kind:asc">File type</option>
          </select>
        </div>

        <Button variant="secondary" icon="folder-plus" onClick={() => setCreating(true)} className="hide-sm">
          New folder
        </Button>

        <div className="upload-split">
          <Button variant="primary" icon="upload" onClick={() => fileInput.current?.click()}>
            Upload files
          </Button>
          <button
            className="upload-split__caret"
            aria-label="More upload options"
            onClick={() => setUploadMenu((value) => !value)}
          >
            <Icon name="chevron-down" size={14} />
          </button>
          {uploadMenu && (
            <>
              <div className="upload-split__backdrop" onMouseDown={() => setUploadMenu(false)} />
              <div className="upload-split__menu">
                <button
                  onClick={() => {
                    setUploadMenu(false);
                    fileInput.current?.click();
                  }}
                >
                  <Icon name="upload" size={15} /> Upload files
                </button>
                <button
                  onClick={() => {
                    setUploadMenu(false);
                    folderInput.current?.click();
                  }}
                >
                  <Icon name="folder" size={15} /> Upload a folder
                </button>
              </div>
            </>
          )}
        </div>

        <input
          ref={fileInput}
          type="file"
          multiple
          hidden
          onChange={() => guardedUploadFromInput(fileInput.current)}
        />
        <input
          ref={folderInput}
          type="file"
          multiple
          hidden
          // @ts-expect-error non-standard but widely supported directory picker
          webkitdirectory=""
          directory=""
          onChange={() => guardedUploadFromInput(folderInput.current)}
        />
      </div>

      <div className="breadcrumbs" aria-label="Breadcrumb">
        {searchMode ? (
          <span className="crumb crumb--current">
            <Icon name="search" size={14} /> Search “{query.trim()}”
            {searching && <span className="crumb__spinner" />}
          </span>
        ) : (
          <>
            <button className="crumb" onClick={() => navigate('/')}>
              <Icon name="inbox" size={15} /> All files
            </button>
            {path
              .split('/')
              .filter(Boolean)
              .map((segment, index, all) => {
                const target = `/${all.slice(0, index + 1).join('/')}`;
                const current = index === all.length - 1;
                return (
                  <span key={target} className="crumb-group">
                    <Icon name="chevron-right" size={13} className="crumb__sep" />
                    <button
                      className={`crumb ${current ? 'crumb--current' : ''}`}
                      onClick={() => navigate(target)}
                    >
                      {segment}
                    </button>
                  </span>
                );
              })}
          </>
        )}
        <span className="breadcrumbs__count">
          {searching ? 'Searching…' : pluralize(displayEntries.length, searchMode ? 'result' : 'item')}
        </span>
      </div>

      {selectionCount > 0 && (
        <div className="selection-bar">
          <span className="selection-bar__count">
            <Icon name="check" size={15} /> {pluralize(selectionCount, 'item')} selected
          </span>
          <div className="selection-bar__actions">
            <Button variant="ghost" size="sm" icon="download" onClick={() => void download(selectedEntries)}>
              Download
            </Button>
            <Button
              variant="ghost"
              size="sm"
              icon="pencil"
              onClick={() => {
                if (selectedEntries.length === 1) {
                  setRenameTarget(selectedEntries[0]);
                  setRenameValue(selectedEntries[0].name);
                }
              }}
              disabled={selectedEntries.length !== 1}
            >
              Rename
            </Button>
            <Button variant="ghost" size="sm" icon="trash" onClick={() => setDeleteTargets(selectedEntries)}>
              Delete
            </Button>
            <Button variant="ghost" size="sm" icon="x" onClick={() => setSelection(new Set())}>
              Clear
            </Button>
          </div>
        </div>
      )}

      <div className="browser__scroll" onClick={(event) => {
        if (event.target === event.currentTarget) setSelection(new Set());
      }}>
        {loading && !listing ? (
          <div className="skeleton-grid">
            {Array.from({ length: 8 }).map((_, index) => (
              <div className="skeleton-card" key={index}>
                <div className="skeleton skeleton--thumb" />
                <div className="skeleton skeleton--line" />
                <div className="skeleton skeleton--line skeleton--short" />
              </div>
            ))}
          </div>
        ) : loadError ? (
          <EmptyState
            icon="cloud-off"
            title="Can’t reach this folder"
            message={loadError}
            action={
              <Button variant="primary" icon="refresh" onClick={() => void load()}>
                Try again
              </Button>
            }
          />
        ) : displayEntries.length === 0 ? (
          searchMode ? (
            <EmptyState
              icon="search"
              title="No matches"
              message={`Nothing on this device matches “${query.trim()}”.`}
            />
          ) : (
            <EmptyState
              icon="folder-plus"
              title="This folder is empty"
              message="Drag files here from your desktop, or pick them from your computer."
              action={
                <Button variant="primary" icon="upload" onClick={() => fileInput.current?.click()}>
                  Upload files
                </Button>
              }
            />
          )
        ) : view === 'grid' ? (
          <div className="file-grid" role="list">
            {displayEntries.map((entry) => (
              <article
                key={entry.path}
                className={`file-card ${selection.has(entry.path) ? 'is-selected' : ''}`}
                role="listitem"
                tabIndex={0}
                onClick={(event) => handleClick(entry, event)}
                onDoubleClick={() => openEntry(entry)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') openEntry(entry);
                  if (event.key === ' ') {
                    event.preventDefault();
                    setSelection((current) => new Set(current).add(entry.path));
                  }
                }}
                onContextMenu={(event) => {
                  event.preventDefault();
                  setSelection(new Set([entry.path]));
                  setMenu({ entry, x: event.clientX, y: event.clientY });
                }}
              >
                <div className="file-card__media">
                  <Thumb entry={entry} client={client} />
                  {entry.kind === 'image' && (
                    <span className="file-card__badge">{formatBytes(entry.size)}</span>
                  )}
                  <button
                    className="file-card__more"
                    aria-label={`Actions for ${entry.name}`}
                    onClick={(event) => {
                      event.stopPropagation();
                      const rect = event.currentTarget.getBoundingClientRect();
                      setMenu({ entry, x: rect.right - 8, y: rect.bottom + 6 });
                    }}
                  >
                    <Icon name="more" size={16} />
                  </button>
                </div>
                <div className="file-card__body">
                  <span className="file-card__name" title={entry.name}>
                    {entry.name}
                  </span>
                  <span className="file-card__meta">
                    {entry.type === 'dir' ? 'Folder' : formatBytes(entry.size)} · {relativeTime(entry.mtime)}
                  </span>
                </div>
                {searchMode && <span className="file-card__path">{parentOf(entry.path)}</span>}
              </article>
            ))}
          </div>
        ) : (
          <div className="file-table" role="table">
            <div className="file-row file-row--head" role="row">
              <span role="columnheader">Name</span>
              <span role="columnheader">Size</span>
              <span role="columnheader">Modified</span>
              <span role="columnheader" aria-label="Actions" />
            </div>
            {displayEntries.map((entry) => (
              <div
                key={entry.path}
                className={`file-row ${selection.has(entry.path) ? 'is-selected' : ''}`}
                role="row"
                tabIndex={0}
                onClick={(event) => handleClick(entry, event)}
                onDoubleClick={() => openEntry(entry)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') openEntry(entry);
                }}
                onContextMenu={(event) => {
                  event.preventDefault();
                  setSelection(new Set([entry.path]));
                  setMenu({ entry, x: event.clientX, y: event.clientY });
                }}
              >
                <span className="file-row__name" role="cell">
                  <KindGlyph entry={entry} size={34} />
                  <span className="file-row__label">
                    <span className="file-row__title">{entry.name}</span>
                    {searchMode && <span className="file-row__path">{parentOf(entry.path)}</span>}
                  </span>
                </span>
                <span className="file-row__size" role="cell">
                  {entry.type === 'dir' ? '—' : formatBytes(entry.size)}
                </span>
                <span className="file-row__date" role="cell">
                  {relativeTime(entry.mtime)}
                </span>
                <span className="file-row__actions" role="cell">
                  {entry.type === 'file' && (
                    <button
                      className="icon-btn icon-btn--xs"
                      aria-label={`Download ${entry.name}`}
                      onClick={(event) => {
                        event.stopPropagation();
                        void download([entry]);
                      }}
                    >
                      <Icon name="download" size={15} />
                    </button>
                  )}
                  <button
                    className="icon-btn icon-btn--xs"
                    aria-label={`Actions for ${entry.name}`}
                    onClick={(event) => {
                      event.stopPropagation();
                      const rect = event.currentTarget.getBoundingClientRect();
                      setMenu({ entry, x: rect.right - 8, y: rect.bottom + 6 });
                    }}
                  >
                    <Icon name="more" size={16} />
                  </button>
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {dragging && (
        <div className="dropzone">
          <div className="dropzone__card">
            <span className="dropzone__icon">
              <Icon name="upload" size={26} />
            </span>
            <strong>Drop to upload</strong>
            <span>Files land in {path === '/' ? 'All files' : path}</span>
          </div>
        </div>
      )}

      {menu?.entry && (
        <div
          className="context-menu"
          style={{
            left: Math.min(menu.x, window.innerWidth - 220),
            top: Math.min(menu.y, window.innerHeight - 240),
          }}
          onMouseDown={(event) => event.stopPropagation()}
        >
          <div className="context-menu__head" title={menu.entry.name}>
            {menu.entry.name}
          </div>
          {menu.entry.type === 'dir' ? (
            <button onClick={() => { navigate(menu.entry!.path); setMenu(null); }}>
              <Icon name="folder" size={15} /> Open folder
            </button>
          ) : (
            <>
              <button onClick={() => { setPreviewEntry(menu.entry); setMenu(null); }}>
                <Icon name="external" size={15} /> Preview
              </button>
              <button onClick={() => { void download([menu.entry!]); setMenu(null); }}>
                <Icon name="download" size={15} /> Download
              </button>
            </>
          )}
          <button
            onClick={() => {
              setRenameTarget(menu.entry);
              setRenameValue(menu.entry!.name);
              setMenu(null);
            }}
          >
            <Icon name="pencil" size={15} /> Rename
          </button>
          <div className="context-menu__sep" />
          <button
            className="context-menu__danger"
            onClick={() => {
              setDeleteTargets([menu.entry!]);
              setMenu(null);
            }}
          >
            <Icon name="trash" size={15} /> Delete
          </button>
        </div>
      )}

      <Modal
        open={creating}
        title="New folder"
        subtitle={`Created inside ${path === '/' ? 'All files' : path}`}
        onClose={() => setCreating(false)}
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => setCreating(false)}>
              Cancel
            </Button>
            <Button variant="primary" onClick={() => void createFolder()} loading={busy} disabled={!newFolderName.trim()}>
              Create folder
            </Button>
          </>
        }
      >
        <label className="field">
          <span>Folder name</span>
          <input
            autoFocus
            value={newFolderName}
            onChange={(event) => setNewFolderName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void createFolder();
            }}
            placeholder="New folder"
          />
        </label>
      </Modal>

      <Modal
        open={Boolean(renameTarget)}
        title="Rename"
        onClose={() => setRenameTarget(null)}
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => setRenameTarget(null)}>
              Cancel
            </Button>
            <Button variant="primary" onClick={() => void rename()} loading={busy} disabled={!renameValue.trim()}>
              Save
            </Button>
          </>
        }
      >
        <label className="field">
          <span>New name</span>
          <input
            autoFocus
            value={renameValue}
            onChange={(event) => setRenameValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void rename();
            }}
          />
        </label>
      </Modal>

      <ConfirmDialog
        open={deleteTargets.length > 0}
        title={deleteTargets.length === 1 ? 'Delete this item?' : `Delete ${deleteTargets.length} items?`}
        message={
          <>
            {deleteTargets.length === 1 ? (
              <>
                <strong>{deleteTargets[0].name}</strong> will be removed from your phone. This cannot be undone.
              </>
            ) : (
              <>These {deleteTargets.length} items will be removed from your phone. This cannot be undone.</>
            )}
          </>
        }
        busy={busy}
        onConfirm={() => void removeEntries(deleteTargets)}
        onClose={() => setDeleteTargets([])}
      />

      <Preview
        client={client}
        entry={previewEntry}
        siblings={displayEntries}
        onNavigate={setPreviewEntry}
        onClose={() => setPreviewEntry(null)}
      />
    </div>
  );
}
