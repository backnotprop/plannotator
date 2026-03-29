/**
 * Real-time external annotations via SSE with polling fallback.
 *
 * Primary transport: EventSource on /api/external-annotations/stream.
 * Fallback: version-gated GET polling if SSE fails (e.g., proxy environments).
 *
 * Generic over the annotation type — plan editor uses Annotation,
 * review editor uses CodeAnnotation. The hook is shape-agnostic;
 * it just serializes/deserializes JSON.
 *
 * Gated by an `enabled` option — callers pass their API-mode signal
 * to avoid SSE/polling in static or demo contexts where there is no server.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import type { ExternalAnnotationEvent } from '../types';

const POLL_INTERVAL_MS = 500;
const STREAM_URL = '/api/external-annotations/stream';
const SNAPSHOT_URL = '/api/external-annotations';

interface UseExternalAnnotationsReturn<T> {
  externalAnnotations: T[];
  updateExternalAnnotation: (id: string, updates: Partial<T>) => void;
  deleteExternalAnnotation: (id: string) => void;
  clearExternalAnnotations: (source?: string) => void;
}

export function useExternalAnnotations<T extends { id: string; source?: string }>(
  options?: { enabled?: boolean },
): UseExternalAnnotationsReturn<T> {
  const enabled = options?.enabled ?? true;
  const [annotations, setAnnotations] = useState<T[]>([]);
  const versionRef = useRef(0);
  const fallbackRef = useRef(false);
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const receivedSnapshotRef = useRef(false);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;

    // --- SSE primary transport ---
    const es = new EventSource(STREAM_URL);

    es.onmessage = (event) => {
      if (cancelled) return;

      try {
        const parsed: ExternalAnnotationEvent<T> = JSON.parse(event.data);

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
        }
      } catch {
        // Ignore malformed events (e.g., heartbeat comments)
      }
    };

    es.onerror = () => {
      // If we never received a snapshot, SSE isn't working — fall back to polling
      if (!receivedSnapshotRef.current && !fallbackRef.current) {
        fallbackRef.current = true;
        es.close();
        startPolling();
      }
      // Otherwise, EventSource will auto-reconnect and we'll get a fresh snapshot
    };

    // --- Polling fallback ---
    function startPolling() {
      if (cancelled) return;

      // Initial fetch
      fetchSnapshot();

      pollTimerRef.current = setInterval(() => {
        if (cancelled) return;
        fetchSnapshot();
      }, POLL_INTERVAL_MS);
    }

    async function fetchSnapshot() {
      try {
        const url =
          versionRef.current > 0
            ? `${SNAPSHOT_URL}?since=${versionRef.current}`
            : SNAPSHOT_URL;

        const res = await fetch(url);

        if (res.status === 304) return; // No changes
        if (!res.ok) return;

        const data = await res.json();
        if (Array.isArray(data.annotations)) {
          setAnnotations(data.annotations);
        }
        if (typeof data.version === 'number') {
          versionRef.current = data.version;
        }
      } catch {
        // Silent — next poll will retry
      }
    }

    return () => {
      cancelled = true;
      es.close();
      if (pollTimerRef.current) {
        clearInterval(pollTimerRef.current);
        pollTimerRef.current = null;
      }
    };
  }, [enabled]);

  const deleteExternalAnnotation = useCallback(async (id: string) => {
    // Optimistic update
    setAnnotations((prev) => prev.filter((a) => a.id !== id));
    try {
      await fetch(
        `${SNAPSHOT_URL}?id=${encodeURIComponent(id)}`,
        { method: 'DELETE' },
      );
    } catch {
      // SSE will reconcile on next event
    }
  }, []);

  const clearExternalAnnotations = useCallback(async (source?: string) => {
    // Optimistic update
    setAnnotations((prev) =>
      source ? prev.filter((a) => a.source !== source) : [],
    );
    try {
      const qs = source ? `?source=${encodeURIComponent(source)}` : '';
      await fetch(`${SNAPSHOT_URL}${qs}`, { method: 'DELETE' });
    } catch {
      // SSE will reconcile on next event
    }
  }, []);

  const updateExternalAnnotation = useCallback(async (id: string, updates: Partial<T>) => {
    setAnnotations((prev) => prev.map((a) => (a.id === id ? { ...a, ...updates } : a)));
    try {
      await fetch(`${SNAPSHOT_URL}?id=${encodeURIComponent(id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates),
      });
    } catch {
      // SSE will reconcile on next event
    }
  }, []);

  return { externalAnnotations: annotations, updateExternalAnnotation, deleteExternalAnnotation, clearExternalAnnotations };
}
