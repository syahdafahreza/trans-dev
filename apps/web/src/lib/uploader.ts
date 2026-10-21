import { ApiError, type TransClient } from './api';
import type { TransferItem } from './types';

const CHUNK_SIZE = 4 * 1024 * 1024; // 4 MB keeps memory flat and progress smooth
const MAX_PARALLEL = 2;
const MAX_ATTEMPTS = 3;

type Listener = (items: TransferItem[]) => void;

interface QueueEntry extends TransferItem {
  file: File;
  controller: AbortController;
  lastTick: number;
  lastSent: number;
}

function newUploadId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    });
  });
}

/**
 * Client-side upload pipeline.
 *
 * Two files move at once; each file is streamed as 4 MB slices with resume support.
 * A dropped Wi-Fi connection resumes from the last acknowledged offset instead of
 * starting over, which matters for multi-gigabyte videos.
 */
export class Uploader {
  private client: TransClient;
  private entries: QueueEntry[] = [];
  private listeners = new Set<Listener>();
  private running = 0;
  private notifyScheduled = false;

  constructor(client: TransClient) {
    this.client = client;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    listener(this.snapshot());
    return () => this.listeners.delete(listener);
  }

  snapshot(): TransferItem[] {
    return this.entries.map(({ file: _file, controller: _controller, lastTick: _t, lastSent: _l, ...item }) => item);
  }

  private notify() {
    if (this.notifyScheduled) return;
    this.notifyScheduled = true;
    queueMicrotask(() => {
      this.notifyScheduled = false;
      const items = this.snapshot();
      for (const listener of this.listeners) listener(items);
    });
  }

  hasActive(): boolean {
    return this.entries.some((entry) => ['queued', 'uploading', 'finishing'].includes(entry.status));
  }

  get activeCount(): number {
    return this.entries.filter((entry) => ['queued', 'uploading', 'finishing'].includes(entry.status)).length;
  }

  enqueue(files: File[], dir: string) {
    const now = Date.now();
    for (const file of files) {
      if (!file.name) continue;
      this.entries.unshift({
        id: `${now}-${Math.random().toString(36).slice(2, 8)}`,
        name: file.name,
        size: file.size,
        dir,
        sent: 0,
        status: 'queued',
        startedAt: now,
        speed: 0,
        attempt: 0,
        file,
        controller: new AbortController(),
        lastTick: now,
        lastSent: 0,
      });
    }
    this.notify();
    this.pump();
  }

  cancel(id: string) {
    const entry = this.entries.find((candidate) => candidate.id === id);
    if (!entry) return;
    entry.controller.abort();
    entry.status = 'canceled';
    entry.speed = 0;
    entry.finishedAt = Date.now();
    this.notify();
  }

  /** Re-queues failed or cancelled transfers, resuming from the last offset. */
  retry(id?: string) {
    for (const entry of this.entries) {
      if (id && entry.id !== id) continue;
      if (!['error', 'canceled'].includes(entry.status)) continue;
      entry.status = 'queued';
      entry.error = undefined;
      entry.attempt = 0;
      entry.controller = new AbortController();
      entry.startedAt = Date.now();
      entry.lastTick = Date.now();
      entry.lastSent = entry.sent;
    }
    this.notify();
    this.pump();
  }

  clearFinished() {
    this.entries = this.entries.filter((entry) => ['queued', 'uploading', 'finishing'].includes(entry.status));
    this.notify();
  }

  private pump() {
    while (this.running < MAX_PARALLEL) {
      const next = [...this.entries].reverse().find((entry) => entry.status === 'queued');
      if (!next) return;
      this.running += 1;
      void this.run(next).finally(() => {
        this.running -= 1;
        this.pump();
      });
    }
  }

  private async run(entry: QueueEntry) {
    entry.status = 'uploading';
    entry.startedAt = Date.now();
    entry.lastTick = Date.now();
    entry.lastSent = entry.sent;
    this.notify();
    const uploadId = newUploadId();

    try {
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
        entry.attempt = attempt;
        try {
          if (attempt > 1) {
            // Resume from whatever the phone already has on disk.
            const status = await this.client.uploadStatus(uploadId).catch(() => null);
            if (status) entry.sent = status.offset;
          }
          const meta = await this.client.uploadBegin({
            uploadId,
            dir: entry.dir,
            name: entry.name,
            size: entry.size,
            signal: entry.controller.signal,
          });
          entry.sent = meta.offset;

          while (entry.sent < entry.size) {
            const start = entry.sent;
            const end = Math.min(start + CHUNK_SIZE, entry.size);
            const chunk = entry.file.slice(start, end);
            const result = await this.client.uploadChunk({
              uploadId,
              offset: start,
              chunk,
              signal: entry.controller.signal,
            });
            entry.sent = result.offset;
            this.tick(entry);
          }

          entry.status = 'finishing';
          this.notify();
          await this.client.uploadFinish(uploadId);
          entry.status = 'done';
          entry.sent = entry.size;
          entry.finishedAt = Date.now();
          entry.speed = 0;
          this.notify();
          return;
        } catch (error) {
          if (error instanceof DOMException && error.name === 'AbortError') {
            entry.status = 'canceled';
            entry.speed = 0;
            entry.finishedAt = Date.now();
            this.notify();
            void this.client.uploadAbort(uploadId).catch(() => {});
            return;
          }
          const apiError = error instanceof ApiError ? error : null;
          const retryable = !apiError || apiError.status === 0 || apiError.status >= 500 || apiError.status === 409;
          if (attempt === MAX_ATTEMPTS || !retryable) {
            entry.status = 'error';
            entry.speed = 0;
            entry.error = apiError?.message ?? (error as Error).message;
            entry.finishedAt = Date.now();
            this.notify();
            return;
          }
          // Back off a little; Wi-Fi hiccups usually clear in a second or two.
          await delay(600 * attempt, entry.controller.signal);
        }
      }
    } catch (error) {
      if (!(error instanceof DOMException)) {
        entry.status = 'error';
        entry.error = (error as Error).message;
        entry.finishedAt = Date.now();
        entry.speed = 0;
        this.notify();
      }
    }
  }

  private tick(entry: QueueEntry) {
    const now = Date.now();
    const elapsed = (now - entry.lastTick) / 1000;
    if (elapsed >= 0.4) {
      const instant = (entry.sent - entry.lastSent) / elapsed;
      entry.speed = entry.speed ? entry.speed * 0.6 + instant * 0.4 : instant;
      entry.lastTick = now;
      entry.lastSent = entry.sent;
    }
    this.notify();
  }
}

export { CHUNK_SIZE };
