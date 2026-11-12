import { useState, useEffect, useCallback, useRef } from 'react';
import type { ExternalAnnotationEvent } from '../types';

const POLL_INTERVAL_MS = 500;
const STREAM_URL = '/api/external-annotations/stream';
const SNAPSHOT_URL = '/api/external-annotations';

export interface ExternalAnnotationTransport<T extends { id: string; source?: string }> {
  subscribe(
    onEvent: (event: ExternalAnnotationEvent<T>) => void,
    onError: () => void,
  ): () => void;
  getSnapshot(since: number): Promise<{ annotations: T[]; version: number } | null>;
  add(items: T[]): Promise<void>;
  remove(id: string): Promise<void>;
  update(id: string, fields: Partial<T>): Promise<void>;
  clear(source?: string): Promise<void>;
}

function createDefaultTransport<T extends { id: string; source?: string }>(): ExternalAnnotationTransport<T> {
  return {
    subscribe(onEvent, onError) {
      const es = new EventSource(STREAM_URL);
      es.onmessage = (event) => {
        try {
          const parsed: ExternalAnnotationEvent<T> = JSON.parse(event.data);
          onEvent(parsed);
        } catch {
        }
      };
      es.onerror = () => {
        onError();
      };
      return () => es.close();
    },
    async getSnapshot(since) {
      const url = since > 0 ? `${SNAPSHOT_URL}?since=${since}` : SNAPSHOT_URL;
      const res = await fetch(url);
      if (res.status === 304) return null;
      if (!res.ok) return null;
      const data = await res.json();
      if (!Array.isArray(data.annotations) || typeof data.version !== 'number') return null;
      return { annotations: data.annotations, version: data.version };
    },
    async add(items) {
      await fetch(SNAPSHOT_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ annotations: items }),
      });
    },
    async remove(id) {
      await fetch(`${SNAPSHOT_URL}?id=${encodeURIComponent(id)}`, { method: 'DELETE' });
    },
    async update(id, fields) {
      await fetch(`${SNAPSHOT_URL}?id=${encodeURIComponent(id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(fields),
      });
    },
    async clear(source) {
      const qs = source ? `?source=${encodeURIComponent(source)}` : '';
      await fetch(`${SNAPSHOT_URL}${qs}`, { method: 'DELETE' });
    },
  };
}

let externalAnnotationTransport: ExternalAnnotationTransport<any> = createDefaultTransport();

export function setExternalAnnotationTransport<T extends { id: string; source?: string }>(
  transport: ExternalAnnotationTransport<T>,
): void {
  externalAnnotationTransport = transport;
}

export function resetExternalAnnotationTransport(): void {
  externalAnnotationTransport = createDefaultTransport();
}

interface UseExternalAnnotationsReturn<T> {
  externalAnnotations: T[];
  updateExternalAnnotation: (id: string, updates: Partial<T>) => void;
  deleteExternalAnnotation: (id: string) => void;
  clearExternalAnnotations: (source?: string) => void;
}

export interface ExternalSessionClosed {
  unsentAnnotations: number;
  by?: 'agent' | 'session';
}

export function useExternalAnnotations<T extends { id: string; source?: string }>(
  options?: {
    enabled?: boolean;
    onSessionClosed?: (event: ExternalSessionClosed) => void;
  },
): UseExternalAnnotationsReturn<T> {
  const enabled = options?.enabled ?? true;
  const onSessionClosedRef = useRef(options?.onSessionClosed);
  onSessionClosedRef.current = options?.onSessionClosed;
  const [annotations, setAnnotations] = useState<T[]>([]);
  const versionRef = useRef(0);
  const fallbackRef = useRef(false);
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const receivedSnapshotRef = useRef(false);
  const transportRef = useRef(externalAnnotationTransport as ExternalAnnotationTransport<T>);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;

    fallbackRef.current = false;
    receivedSnapshotRef.current = false;

    transportRef.current = externalAnnotationTransport as ExternalAnnotationTransport<T>;
    const transport = transportRef.current;

    function applyEvent(parsed: ExternalAnnotationEvent<T>) {
      switch (parsed.type) {
        case 'snapshot':
          receivedSnapshotRef.current = true;
          setAnnotations(parsed.annotations);
          break;
        case 'add':
          setAnnotations((prev) => [...prev, ...parsed.annotations]);
          break;
        case 'remove':
          setAnnotations((prev) =>
            prev.filter((a) => !parsed.ids.includes(a.id)),
          );
          break;
        case 'clear':
          setAnnotations((prev) =>
            parsed.source
              ? prev.filter((a) => a.source !== parsed.source)
              : [],
          );
          break;
        case 'update':
          setAnnotations((prev) =>
            prev.map((a) => a.id === parsed.id ? (parsed.annotation as T) : a),
          );
          break;
        case 'session-closed':
          onSessionClosedRef.current?.({
            unsentAnnotations: typeof parsed.unsentAnnotations === 'number' ? parsed.unsentAnnotations : 0,
            by: parsed.by === 'session' ? 'session' : 'agent',
          });
          break;
      }
    }

    let unsubscribe: (() => void) | undefined;
    unsubscribe = transport.subscribe(
      (parsed) => {
        if (cancelled) return;
        applyEvent(parsed);
      },
      () => {
        if (!receivedSnapshotRef.current && !fallbackRef.current) {
          fallbackRef.current = true;
          unsubscribe?.();
          startPolling();
        }
      },
    );

    function startPolling() {
      if (cancelled) return;

      fetchSnapshot();

      pollTimerRef.current = setInterval(() => {
        if (cancelled) return;
        fetchSnapshot();
      }, POLL_INTERVAL_MS);
    }

    async function fetchSnapshot() {
      try {
        const snap = await transport.getSnapshot(versionRef.current);
        if (snap === null) return;
        setAnnotations(snap.annotations);
        versionRef.current = snap.version;
      } catch {
      }
    }

    return () => {
      cancelled = true;
      unsubscribe?.();
      if (pollTimerRef.current) {
        clearInterval(pollTimerRef.current);
        pollTimerRef.current = null;
      }
    };
  }, [enabled]);

  const deleteExternalAnnotation = useCallback(async (id: string) => {
    setAnnotations((prev) => prev.filter((a) => a.id !== id));
    try {
      await transportRef.current.remove(id);
    } catch {
    }
  }, []);

  const clearExternalAnnotations = useCallback(async (source?: string) => {
    setAnnotations((prev) =>
      source ? prev.filter((a) => a.source !== source) : [],
    );
    try {
      await transportRef.current.clear(source);
    } catch {
    }
  }, []);

  const updateExternalAnnotation = useCallback(async (id: string, updates: Partial<T>) => {
    setAnnotations((prev) => prev.map((a) => (a.id === id ? { ...a, ...updates } : a)));
    try {
      await transportRef.current.update(id, updates);
    } catch {
    }
  }, []);

  return { externalAnnotations: annotations, updateExternalAnnotation, deleteExternalAnnotation, clearExternalAnnotations };
}
