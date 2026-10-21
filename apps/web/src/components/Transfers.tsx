import { useState } from 'react';

import { formatBytes, formatEta, formatSpeed, percent } from '../lib/format';
import type { TransferItem } from '../lib/types';
import { Icon } from './Icon';
import { ProgressBar } from './ui';

interface TransfersProps {
  items: TransferItem[];
  onCancel: (id: string) => void;
  onRetry: (id: string) => void;
  onClear: () => void;
}

export function Transfers({ items, onCancel, onRetry, onClear }: TransfersProps) {
  const [open, setOpen] = useState(true);
  if (items.length === 0) return null;

  const active = items.filter((item) => ['queued', 'uploading', 'finishing'].includes(item.status));
  const failed = items.filter((item) => item.status === 'error');
  const completed = items.filter((item) => item.status === 'done');
  const totalBytes = items.reduce((sum, item) => sum + item.size, 0);
  const sentBytes = items.reduce((sum, item) => sum + (item.status === 'done' ? item.size : item.sent), 0);
  const overall = percent(sentBytes, totalBytes);

  const headline = active.length
    ? `Uploading ${active.length} ${active.length === 1 ? 'file' : 'files'}`
    : failed.length
      ? `${failed.length} failed`
      : 'Uploads complete';

  return (
    <aside className={`transfers ${open ? 'is-open' : 'is-collapsed'}`} aria-label="Transfers">
      <header className="transfers__head" onClick={() => setOpen((value) => !value)}>
        <span className="transfers__icon">
          <Icon name={active.length ? 'upload' : failed.length ? 'alert' : 'check'} size={16} />
        </span>
        <div className="transfers__titles">
          <strong>{headline}</strong>
          <span>
            {formatBytes(sentBytes)} of {formatBytes(totalBytes)}
            {active.length > 0 && ` · ${Math.round(overall)}%`}
          </span>
        </div>
        <button
          className="icon-btn icon-btn--xs"
          aria-label={open ? 'Collapse transfers' : 'Expand transfers'}
          onClick={(event) => {
            event.stopPropagation();
            setOpen((value) => !value);
          }}
        >
          <Icon name={open ? 'chevron-down' : 'chevron-up'} size={16} />
        </button>
      </header>

      {active.length > 0 && (
        <div className="transfers__overall">
          <ProgressBar value={overall} />
        </div>
      )}

      {open && (
        <>
          <ul className="transfers__list">
            {items.slice(0, 30).map((item) => {
              const progress = item.size ? percent(item.sent, item.size) : 0;
              const eta = item.speed > 0 ? (item.size - item.sent) / item.speed : 0;
              return (
                <li key={item.id} className={`transfer transfer--${item.status}`}>
                  <span className="transfer__glyph">
                    <Icon
                      name={
                        item.status === 'done'
                          ? 'check'
                          : item.status === 'error'
                            ? 'alert'
                            : item.status === 'canceled'
                              ? 'x'
                              : 'file'
                      }
                      size={15}
                    />
                  </span>
                  <div className="transfer__body">
                    <div className="transfer__top">
                      <span className="transfer__name" title={item.name}>
                        {item.name}
                      </span>
                      <span className="transfer__status">
                        {item.status === 'done'
                          ? 'Done'
                          : item.status === 'error'
                            ? 'Failed'
                            : item.status === 'canceled'
                              ? 'Cancelled'
                              : item.status === 'finishing'
                                ? 'Saving…'
                                : `${Math.round(progress)}%`}
                      </span>
                    </div>
                    <ProgressBar
                      value={item.status === 'error' ? 100 : progress}
                      tone={item.status === 'error' ? 'danger' : item.status === 'done' ? 'success' : 'accent'}
                    />
                    <div className="transfer__meta">
                      <span>
                        {formatBytes(Math.min(item.sent, item.size))} / {formatBytes(item.size)}
                      </span>
                      {item.status === 'uploading' && item.speed > 0 && (
                        <span>
                          {formatSpeed(item.speed)}
                          {eta > 0 && ` · ${formatEta(eta)}`}
                        </span>
                      )}
                      {item.status === 'error' && <span className="transfer__error">{item.error}</span>}
                      {item.status === 'queued' && <span>Waiting…</span>}
                    </div>
                  </div>
                  <div className="transfer__actions">
                    {['queued', 'uploading', 'finishing'].includes(item.status) && (
                      <button className="icon-btn icon-btn--xs" onClick={() => onCancel(item.id)} aria-label="Cancel upload">
                        <Icon name="x" size={14} />
                      </button>
                    )}
                    {['error', 'canceled'].includes(item.status) && (
                      <button className="icon-btn icon-btn--xs" onClick={() => onRetry(item.id)} aria-label="Retry upload">
                        <Icon name="refresh" size={14} />
                      </button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
          <footer className="transfers__foot">
            <span>
              {completed.length > 0
                ? `${completed.length} saved to your phone`
                : active.length > 0
                  ? 'Keep this tab open while files upload'
                  : 'Transfer interrupted'}
            </span>
            {!active.length && (
              <button className="link-btn" onClick={onClear}>
                Clear
              </button>
            )}
          </footer>
        </>
      )}
    </aside>
  );
}
