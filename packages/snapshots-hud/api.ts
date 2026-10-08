/**
 * The HUD's client for the Snapshots hub. Every call carries the HUD token in an
 * Authorization header: the native app injects it (`window.__SNAPSHOTS__`), a
 * browser fallback gets it in the URL fragment (`/hud#t=…`, which the server
 * never sees). Images are fetched with the header too and shown as object URLs.
 */

import type { Snapshot, SnapshotsState } from '@plannotator/shared/snapshots/types';

declare global {
  interface Window {
    __SNAPSHOTS__?: { token: string; native?: boolean };
  }
}

function readToken(): string | null {
  if (window.__SNAPSHOTS__?.token) return window.__SNAPSHOTS__.token;
  const match = /(?:^|[#&])t=([0-9a-f]{32,})/.exec(window.location.hash);
  if (match) {
    sessionStorage.setItem('plannotator-snapshots-token', match[1]!);
    history.replaceState(null, '', window.location.pathname);
    return match[1]!;
  }
  return sessionStorage.getItem('plannotator-snapshots-token');
}

export const token = readToken();

function headers(extra?: Record<string, string>): Record<string, string> {
  return { authorization: `Bearer ${token ?? ''}`, ...extra };
}

export class HubError extends Error {
  readonly status: number;
  readonly code?: string;
  constructor(message: string, status: number, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method,
    headers: headers(body !== undefined ? { 'content-type': 'application/json' } : undefined),
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  const value = text ? (JSON.parse(text) as T & { error?: string; code?: string }) : ({} as T & { error?: string; code?: string });
  if (!response.ok) throw new HubError(value.error ?? `Request failed (${response.status})`, response.status, value.code);
  return value;
}

export const api = {
  state: () => call<SnapshotsState>('GET', '/api/snapshots/state'),
  patchSnapshot: (id: string, patch: Partial<Pick<Snapshot, 'boxes' | 'strokes' | 'redactions' | 'note'>> & { text?: { include?: boolean; removedLines?: number[] } }) =>
    call<Snapshot>('PATCH', `/api/snapshots/snapshot/${id}`, patch),
  deleteSnapshot: (id: string) => call('DELETE', `/api/snapshots/snapshot/${id}`),
  text: async (id: string): Promise<string> => {
    const response = await fetch(`/api/snapshots/snapshot/${id}/text`, { headers: headers() });
    return response.ok ? response.text() : '';
  },
  putDerived: async (id: string, name: string, blob: Blob, boxId?: string) => {
    const response = await fetch(`/api/snapshots/snapshot/${id}/derived/${name}${boxId ? `?box=${encodeURIComponent(boxId)}` : ''}`, {
      method: 'PUT',
      headers: headers({ 'content-type': blob.type || 'image/png' }),
      body: blob,
    });
    if (!response.ok) throw new HubError(`Could not save ${name}`, response.status);
  },
  updateCollection: (id: string, patch: { note?: string; destination?: { host: string; sessionId: string } | null; order?: string[] }) =>
    call('POST', `/api/snapshots/collection/${id}`, patch),
  send: (id: string, destination?: { host: string; sessionId: string }) =>
    call<{ sendId: string; text: string }>('POST', `/api/snapshots/collection/${id}/send`, destination ? { destination } : {}),
  retarget: (id: string, destination: { host: string; sessionId: string }) => call('POST', `/api/snapshots/collection/${id}/retarget`, { destination }),
  copy: (id: string) => call<{ text: string; files: string[] }>('POST', `/api/snapshots/collection/${id}/copy`, {}),
  markdown: (id: string) => call<{ text: string; files: string[] }>('POST', `/api/snapshots/collection/${id}/markdown`, {}),
  reveal: (id: string) => call('POST', `/api/snapshots/collection/${id}/reveal`, {}),
  discard: (id: string) => call('DELETE', `/api/snapshots/collection/${id}`),
  restore: (id: string) => call('POST', `/api/snapshots/collection/${id}/restore`, {}),
  settings: (patch: { appCapture?: boolean; captureMode?: 'screen' | 'app'; explainerSeen?: boolean }) => call('POST', '/api/snapshots/settings', patch),
};

/** Follow the hub's state stream; reconnects until stopped. */
export function followState(onState: (state: SnapshotsState) => void, onConnection: (connected: boolean) => void): () => void {
  let stopped = false;
  let controller: AbortController | null = null;
  const run = async () => {
    while (!stopped) {
      controller = new AbortController();
      try {
        const response = await fetch('/api/snapshots/events', { headers: headers(), signal: controller.signal });
        if (!response.ok || !response.body) throw new Error(String(response.status));
        onConnection(true);
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let index: number;
          while ((index = buffer.indexOf('\n\n')) >= 0) {
            const chunk = buffer.slice(0, index);
            buffer = buffer.slice(index + 2);
            const data = chunk
              .split('\n')
              .filter((line) => line.startsWith('data: '))
              .map((line) => line.slice(6))
              .join('\n');
            if (data) onState(JSON.parse(data) as SnapshotsState);
          }
        }
      } catch {
        // Reconnect below.
      }
      onConnection(false);
      if (!stopped) await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  };
  void run();
  return () => {
    stopped = true;
    controller?.abort();
  };
}

/** A streamed Ask: each AI message as it arrives. */
export async function streamAsk(
  body: { question: string; snapshotIds: string[]; boxIds: string[]; busyPolicy?: 'wait' | 'interrupt'; host?: string; sessionId?: string },
  onMessage: (message: Record<string, unknown>) => void,
  signal: AbortSignal,
): Promise<void> {
  const response = await fetch('/api/snapshots/ask', {
    method: 'POST',
    headers: headers({ 'content-type': 'application/json' }),
    body: JSON.stringify(body),
    signal,
  });
  if (!response.ok || !response.body) {
    const value = (await response.json().catch(() => ({}))) as { error?: string; code?: string };
    onMessage({ type: 'error', error: value.error ?? `Ask failed (${response.status})`, code: value.code });
    return;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let index: number;
    while ((index = buffer.indexOf('\n\n')) >= 0) {
      const chunk = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      if (chunk.startsWith('data: ')) onMessage(JSON.parse(chunk.slice(6)) as Record<string, unknown>);
    }
  }
}

const imageCache = new Map<string, Promise<string>>();

/** An object URL for one of a snapshot's files, fetched once. */
export function snapshotImageUrl(snapshotId: string, file: string): Promise<string> {
  const key = `${snapshotId}/${file}`;
  let pending = imageCache.get(key);
  if (!pending) {
    pending = fetch(`/api/snapshots/snapshot/${snapshotId}/file/${file}`, { headers: headers() }).then(async (response) => {
      if (!response.ok) throw new Error(`image ${response.status}`);
      return URL.createObjectURL(await response.blob());
    });
    pending.catch(() => imageCache.delete(key));
    imageCache.set(key, pending);
  }
  return pending;
}
