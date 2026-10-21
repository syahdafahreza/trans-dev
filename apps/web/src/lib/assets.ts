import { useEffect, useState } from 'react';

import type { TransClient } from './api';

interface CachedAsset {
  url: string;
  fetchedAt: number;
}

const assetCache = new Map<string, CachedAsset>();
const inFlight = new Map<string, Promise<string>>();
const CACHE_MS = 4 * 60 * 1000; // signed URLs live for 10 minutes

function cacheKey(path: string, mode: string) {
  return `${mode}:${path}`;
}

export async function getAssetUrl(
  client: TransClient,
  path: string,
  mode: 'inline' | 'download' = 'inline',
): Promise<string> {
  const key = cacheKey(path, mode);
  const cached = assetCache.get(key);
  if (cached && Date.now() - cached.fetchedAt < CACHE_MS) return cached.url;

  const existing = inFlight.get(key);
  if (existing) return existing;

  const request = client
    .assetUrl(path, mode)
    .then((url) => {
      assetCache.set(key, { url, fetchedAt: Date.now() });
      return url;
    })
    .finally(() => inFlight.delete(key));

  inFlight.set(key, request);
  return request;
}

export function invalidateAsset(path?: string) {
  if (!path) {
    assetCache.clear();
    return;
  }
  for (const key of [...assetCache.keys()]) {
    if (key.endsWith(`:${path}`)) assetCache.delete(key);
  }
}

/** Resolves a signed URL for one file, with in-memory caching across tiles. */
export function useAssetUrl(
  client: TransClient,
  path: string | null,
  mode: 'inline' | 'download' = 'inline',
  enabled = true,
) {
  const [state, setState] = useState<{ url: string | null; error: string | null }>({ url: null, error: null });

  useEffect(() => {
    if (!path || !enabled) return;
    let cancelled = false;
    const key = cacheKey(path, mode);
    const cached = assetCache.get(key);
    if (cached && Date.now() - cached.fetchedAt < CACHE_MS) {
      setState({ url: cached.url, error: null });
      return;
    }
    setState({ url: null, error: null });
    getAssetUrl(client, path, mode)
      .then((url) => {
        if (!cancelled) setState({ url, error: null });
      })
      .catch((error: Error) => {
        if (!cancelled) setState({ url: null, error: error.message });
      });
    return () => {
      cancelled = true;
    };
  }, [client, path, mode, enabled]);

  return state;
}

export async function downloadFile(client: TransClient, path: string, name: string) {
  const url = await getAssetUrl(client, path, 'download');
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  anchor.rel = 'noopener';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}
