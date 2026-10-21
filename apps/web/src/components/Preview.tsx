import { useEffect, useState } from 'react';

import type { TransClient } from '../lib/api';
import { downloadFile, useAssetUrl } from '../lib/assets';
import { formatBytes, formatDate } from '../lib/format';
import type { Entry } from '../lib/types';
import { Icon } from './Icon';
import { Button, KindGlyph } from './ui';

interface PreviewProps {
  client: TransClient;
  entry: Entry | null;
  siblings: Entry[];
  onNavigate: (entry: Entry) => void;
  onClose: () => void;
}

export function Preview({ client, entry, siblings, onNavigate, onClose }: PreviewProps) {
  const isPreviewable = Boolean(
    entry && ['image', 'video', 'audio', 'pdf', 'text', 'code'].includes(entry.kind) && entry.type === 'file',
  );
  const { url, error } = useAssetUrl(client, entry?.path ?? null, 'inline', isPreviewable && entry?.kind !== 'text' && entry?.kind !== 'code');
  const [textContent, setTextContent] = useState<string | null>(null);
  const [textError, setTextError] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);

  const navigable = siblings.filter((candidate) => candidate.type === 'file');
  const index = entry ? navigable.findIndex((candidate) => candidate.path === entry.path) : -1;

  useEffect(() => {
    if (!entry || (entry.kind !== 'text' && entry.kind !== 'code')) {
      setTextContent(null);
      setTextError(null);
      return;
    }
    let cancelled = false;
    setTextContent(null);
    setTextError(null);
    client
      .assetResponse(entry.path)
      .then((response) => response.text())
      .then((text) => {
        if (cancelled) return;
        setTextContent(text.length > 200_000 ? `${text.slice(0, 200_000)}\n\n… file truncated for preview` : text);
      })
      .catch((exception: Error) => {
        if (!cancelled) setTextError(exception.message);
      });
    return () => {
      cancelled = true;
    };
  }, [client, entry]);

  useEffect(() => {
    if (!entry) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
      if (event.key === 'ArrowRight' && index >= 0 && index < navigable.length - 1) {
        onNavigate(navigable[index + 1]);
      }
      if (event.key === 'ArrowLeft' && index > 0) {
        onNavigate(navigable[index - 1]);
      }
    };
    window.addEventListener('keydown', onKey);
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = previous;
    };
  }, [entry, index, navigable, onClose, onNavigate]);

  if (!entry) return null;

  async function handleDownload() {
    if (!entry) return;
    setDownloading(true);
    try {
      await downloadFile(client, entry.path, entry.name);
    } finally {
      setDownloading(false);
    }
  }

  return (
    <div className="preview" role="dialog" aria-modal="true" aria-label={`Preview of ${entry.name}`}>
      <div className="preview__backdrop" onMouseDown={onClose} />
      <div className="preview__panel">
        <header className="preview__head">
          <KindGlyph entry={entry} size={38} />
          <div className="preview__titles">
            <h2 title={entry.name}>{entry.name}</h2>
            <span>
              {formatBytes(entry.size)} · {entry.ext ? entry.ext.toUpperCase() : 'File'} · {formatDate(entry.mtime)}
            </span>
          </div>
          <div className="preview__actions">
            <Button variant="secondary" size="sm" icon="download" onClick={() => void handleDownload()} loading={downloading}>
              Download
            </Button>
            <button className="icon-btn" onClick={onClose} aria-label="Close preview">
              <Icon name="x" size={18} />
            </button>
          </div>
        </header>

        <div className="preview__stage">
          <button
            className="preview__nav preview__nav--prev"
            onClick={() => index > 0 && onNavigate(navigable[index - 1])}
            disabled={index <= 0}
            aria-label="Previous file"
          >
            <Icon name="chevron-left" size={20} />
          </button>

          <div className="preview__content">
            {entry.kind === 'image' && url && <img src={url} alt={entry.name} />}
            {entry.kind === 'video' && url && (
              <video src={url} controls autoPlay playsInline preload="metadata" />
            )}
            {entry.kind === 'audio' && url && (
              <div className="preview__audio">
                <span className="preview__audio-art">
                  <Icon name="audio" size={56} />
                </span>
                <strong>{entry.name}</strong>
                <audio src={url} controls autoPlay />
              </div>
            )}
            {entry.kind === 'pdf' && url && <iframe src={url} title={entry.name} className="preview__pdf" />}
            {(entry.kind === 'text' || entry.kind === 'code') && (
              <>
                {textError && <p className="muted">{textError}</p>}
                {!textError && textContent === null && <span className="muted">Loading preview…</span>}
                {textContent !== null && <pre className="preview__text">{textContent}</pre>}
              </>
            )}
            {!isPreviewable && (
              <div className="preview__fallback">
                <span className="preview__fallback-icon">
                  <Icon name="file" size={40} />
                </span>
                <h3>No preview for this file type</h3>
                <p>Download it to open with an app on this computer.</p>
                <Button variant="primary" icon="download" onClick={() => void handleDownload()} loading={downloading}>
                  Download {formatBytes(entry.size)}
                </Button>
              </div>
            )}
            {isPreviewable && !url && !error && entry.kind !== 'text' && entry.kind !== 'code' && (
              <div className="preview__loading">
                <span className="spinner__ring" />
              </div>
            )}
            {error && <p className="muted">{error}</p>}
          </div>

          <button
            className="preview__nav preview__nav--next"
            onClick={() => index >= 0 && index < navigable.length - 1 && onNavigate(navigable[index + 1])}
            disabled={index < 0 || index >= navigable.length - 1}
            aria-label="Next file"
          >
            <Icon name="chevron-right" size={20} />
          </button>
        </div>

        <footer className="preview__foot">
          <span>
            <Icon name="wifi" size={14} /> Streaming from your phone
          </span>
          <span>
            {index >= 0 ? `${index + 1} of ${navigable.length}` : ''}
          </span>
        </footer>
      </div>
    </div>
  );
}
