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

/**
 * Wire transport for external annotations. The hook owns the state machine
 * (reducer, fallback-once SSE→polling, version-scoping, optimistic mutation,
 * enabled gate); the transport owns ONLY the network/event wire.
 *
 * Default = Plannotator's SSE→polling behavior, verbatim. A host (Workspaces)
 * can implement the same contract over its own backend (e.g. Durable Objects).
 */
export interface ExternalAnnotationTransport<T extends { id: string; source?: string }> {
  /** Open the live event stream. Returns an unsubscribe fn that tears it down. */
  subscribe(
    onEvent: (event: ExternalAnnotationEvent<T>) => void,
    onError: () => void,
  ): () => void;
  /** Fetch a version-gated snapshot. Resolves null when there are no changes (304). */
  getSnapshot(since: number): Promise<{ annotations: T[]; version: number } | null>;
  add(items: T[]): Promise<void>;
  remove(id: string): Promise<void>;
  update(id: string, fields: Partial<T>): Promise<void>;
  clear(source?: string): Promise<void>;
}

/**
 * Default transport — Plannotator's verbatim SSE→polling wire.
 * EventSource on /api/external-annotations/stream; GET snapshot honoring 304→null;
 * CRUD via DELETE/PATCH fetches (optimistic local mutation stays in the hook).
 */
function createDefaultTransport<T extends { id: string; source?: string }>(): ExternalAnnotationTransport<T> {
  return {
    subscribe(onEvent, onError) {
      const es = new EventSource(STREAM_URL);
      es.onmessage = (event) => {
        try {
          const parsed: ExternalAnnotationEvent<T> = JSON.parse(event.data);
          onEvent(parsed);
        } catch {
          // Ignore malformed events (e.g., heartbeat comments)
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
      if (res.status === 304) return null; // No changes
      if (!res.ok) return null;
      const data = await res.json();
      // Skip (don't apply) on a malformed 200 — preserves existing annotations
      // and the version cursor instead of clearing them, matching the
      // pre-seam fetchSnapshot which only updated on well-formed payloads.
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

/** Override the external-annotation wire transport. Call once at app startup. */
export function setExternalAnnotationTransport<T extends { id: string; source?: string }>(
  transport: ExternalAnnotationTransport<T>,
): void {
  externalAnnotationTransport = transport;
}

/** Reset to the default (Plannotator SSE→polling) transport. Mainly for tests. */
export function resetExternalAnnotationTransport(): void {
  externalAnnotationTransport = createDefaultTransport();
}

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
  // Holds the active transport, shared by subscribe/poll AND the CRUD callbacks so
  // reads and writes never split across backends. (Re-)captured from the module
  // global when the effect runs on enable (below), so a host that installs a
  // transport before enabling annotations is honored, not the stale default.
  const transportRef = useRef(externalAnnotationTransport as ExternalAnnotationTransport<T>);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;

    // Reset fallback state on (re-)enable so a false→true toggle re-attempts SSE
    // instead of inheriting a stale "already fell back" flag and silently stalling.
    fallbackRef.current = false;
    receivedSnapshotRef.current = false;

    // Capture the active transport at (re-)enable so a late host override is used.
    transportRef.current = externalAnnotationTransport as ExternalAnnotationTransport<T>;
    const transport = transportRef.current;

    // --- Reducer (applies snapshot|add|remove|clear|update), verbatim ---
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
      }
    }

    // --- SSE primary transport ---
    // `let` (not `const`) so onError firing synchronously during subscribe — a host
    // transport may do this when its channel is immediately unavailable — reads a
    // declared-but-undefined binding (no-op) instead of hitting the TDZ and throwing.
    let unsubscribe: (() => void) | undefined;
    unsubscribe = transport.subscribe(
      (parsed) => {
        if (cancelled) return;
        applyEvent(parsed);
      },
      () => {
        // If we never received a snapshot, SSE isn't working — fall back to polling
        if (!receivedSnapshotRef.current && !fallbackRef.current) {
          fallbackRef.current = true;
          unsubscribe?.();
          startPolling();
        }
        // Otherwise, EventSource will auto-reconnect and we'll get a fresh snapshot
      },
    );

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
        const snap = await transport.getSnapshot(versionRef.current);
        if (snap === null) return; // No changes (304) or unavailable
        setAnnotations(snap.annotations);
        versionRef.current = snap.version;
      } catch {
        // Silent — next poll will retry
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
    // Optimistic update
    setAnnotations((prev) => prev.filter((a) => a.id !== id));
    try {
      await transportRef.current.remove(id);
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
      await transportRef.current.clear(source);
    } catch {
      // SSE will reconcile on next event
    }
  }, []);

  const updateExternalAnnotation = useCallback(async (id: string, updates: Partial<T>) => {
    setAnnotations((prev) => prev.map((a) => (a.id === id ? { ...a, ...updates } : a)));
    try {
      await transportRef.current.update(id, updates);
    } catch {
      // SSE will reconcile on next event
    }
  }, []);

  return { externalAnnotations: annotations, updateExternalAnnotation, deleteExternalAnnotation, clearExternalAnnotations };
}
