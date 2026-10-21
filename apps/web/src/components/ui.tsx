import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

import { extensionLabel } from '../lib/format';
import type { Entry, EntryKind } from '../lib/types';
import { Icon, type IconName } from './Icon';

// ----------------------------------------------------------------------- glyphs

const kindMeta: Record<EntryKind, { icon: IconName; tone: string }> = {
  folder: { icon: 'folder', tone: 'indigo' },
  image: { icon: 'image', tone: 'sky' },
  video: { icon: 'video', tone: 'violet' },
  audio: { icon: 'audio', tone: 'rose' },
  pdf: { icon: 'pdf', tone: 'red' },
  document: { icon: 'file-text', tone: 'blue' },
  spreadsheet: { icon: 'sheet', tone: 'emerald' },
  presentation: { icon: 'presentation', tone: 'orange' },
  text: { icon: 'file-text', tone: 'slate' },
  code: { icon: 'code', tone: 'teal' },
  archive: { icon: 'archive', tone: 'amber' },
  app: { icon: 'zap', tone: 'green' },
  contact: { icon: 'users', tone: 'cyan' },
  file: { icon: 'file', tone: 'slate' },
};

export function KindGlyph({ entry, size = 40 }: { entry: Entry; size?: number }) {
  const meta = kindMeta[entry.kind] ?? kindMeta.file;
  const showExtension = entry.type === 'file' && entry.kind !== 'pdf' && entry.kind !== 'image';
  return (
    <span className={`glyph glyph--${meta.tone}`} style={{ width: size, height: size }} data-kind={entry.kind}>
      <Icon name={meta.icon} size={Math.round(size * 0.52)} strokeWidth={1.6} />
      {showExtension && size >= 36 && <span className="glyph__ext">{extensionLabel(entry)}</span>}
    </span>
  );
}

export function kindTone(kind: EntryKind): string {
  return kindMeta[kind]?.tone ?? 'slate';
}

// ---------------------------------------------------------------------- buttons

type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  size?: 'sm' | 'md';
  icon?: IconName;
  loading?: boolean;
};

export function Button({
  variant = 'secondary',
  size = 'md',
  icon,
  loading,
  children,
  className = '',
  disabled,
  ...rest
}: ButtonProps) {
  return (
    <button
      className={`btn btn--${variant} btn--${size} ${className}`.trim()}
      disabled={disabled || loading}
      {...rest}
    >
      {loading ? <Icon name="loader" size={16} className="spin" /> : icon ? <Icon name={icon} size={16} /> : null}
      {children}
    </button>
  );
}

// ----------------------------------------------------------------------- modal

export function Modal({
  open,
  title,
  subtitle,
  onClose,
  children,
  footer,
  size = 'md',
  dismissible = true,
}: {
  open: boolean;
  title: string;
  subtitle?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  size?: 'sm' | 'md' | 'lg' | 'xl';
  dismissible?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && dismissible) {
        event.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('keydown', onKey);
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    ref.current?.focus();
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = previous;
    };
  }, [open, onClose, dismissible]);

  if (!open) return null;

  return (
    <div className="overlay" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget && dismissible) onClose();
    }}>
      <div
        className={`modal modal--${size}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        ref={ref}
      >
        <header className="modal__head">
          <div>
            <h2>{title}</h2>
            {subtitle && <p className="modal__subtitle">{subtitle}</p>}
          </div>
          {dismissible && (
            <button className="icon-btn" onClick={onClose} aria-label="Close">
              <Icon name="x" size={18} />
            </button>
          )}
        </header>
        <div className="modal__body">{children}</div>
        {footer && <footer className="modal__foot">{footer}</footer>}
      </div>
    </div>
  );
}

export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = 'Delete',
  tone = 'danger',
  busy,
  onConfirm,
  onClose,
}: {
  open: boolean;
  title: string;
  message: ReactNode;
  confirmLabel?: string;
  tone?: 'danger' | 'primary';
  busy?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <Modal
      open={open}
      title={title}
      onClose={onClose}
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant={tone === 'danger' ? 'danger' : 'primary'} onClick={onConfirm} loading={busy}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <p className="muted">{message}</p>
    </Modal>
  );
}

// ---------------------------------------------------------------------- toasts

export interface Toast {
  id: string;
  title: string;
  message?: string;
  tone: 'info' | 'success' | 'error';
}

export function useToasts() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const timers = useRef(new Map<string, number>());

  const dismiss = useCallback((id: string) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
    const timer = timers.current.get(id);
    if (timer) {
      window.clearTimeout(timer);
      timers.current.delete(id);
    }
  }, []);

  const notify = useCallback(
    (toast: Omit<Toast, 'id'>) => {
      const id = Math.random().toString(36).slice(2, 9);
      setToasts((current) => [...current.slice(-3), { ...toast, id }]);
      const timer = window.setTimeout(() => dismiss(id), toast.tone === 'error' ? 6500 : 4200);
      timers.current.set(id, timer);
    },
    [dismiss],
  );

  useEffect(() => {
    const map = timers.current;
    return () => {
      for (const timer of map.values()) window.clearTimeout(timer);
      map.clear();
    };
  }, []);

  return { toasts, notify, dismiss };
}

export function ToastStack({ toasts, onDismiss }: { toasts: Toast[]; onDismiss: (id: string) => void }) {
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((toast) => (
        <div key={toast.id} className={`toast toast--${toast.tone}`}>
          <span className="toast__icon">
            <Icon name={toast.tone === 'error' ? 'alert' : toast.tone === 'success' ? 'check' : 'shield'} size={16} />
          </span>
          <div className="toast__body">
            <strong>{toast.title}</strong>
            {toast.message && <span>{toast.message}</span>}
          </div>
          <button className="icon-btn icon-btn--xs" onClick={() => onDismiss(toast.id)} aria-label="Dismiss">
            <Icon name="x" size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}

// ----------------------------------------------------------------------- misc

export function Spinner({ label }: { label?: string }) {
  return (
    <div className="spinner" role="status">
      <span className="spinner__ring" />
      {label && <span className="muted">{label}</span>}
    </div>
  );
}

export function EmptyState({
  icon = 'folder',
  title,
  message,
  action,
}: {
  icon?: IconName;
  title: string;
  message?: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      <span className="empty__icon">
        <Icon name={icon} size={26} />
      </span>
      <h3>{title}</h3>
      {message && <p>{message}</p>}
      {action}
    </div>
  );
}

export function ProgressBar({ value, tone = 'accent' }: { value: number; tone?: 'accent' | 'danger' | 'success' }) {
  return (
    <div className="progress" role="progressbar" aria-valuenow={Math.round(value)} aria-valuemin={0} aria-valuemax={100}>
      <span className={`progress__fill progress__fill--${tone}`} style={{ width: `${Math.min(100, Math.max(0, value))}%` }} />
    </div>
  );
}

export function Pill({ children, tone = 'neutral' }: { children: ReactNode; tone?: string }) {
  return <span className={`pill pill--${tone}`}>{children}</span>;
}
