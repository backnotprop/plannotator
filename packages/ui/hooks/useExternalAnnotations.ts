/**
 * Real-time external annotations via the daemon WebSocket hub.
 *
 * Generic over the annotation type — plan editor uses Annotation,
 * review editor uses CodeAnnotation. The hook is shape-agnostic;
 * it just serializes/deserializes JSON.
 *
 * Gated by an `enabled` option — callers pass their API-mode signal
 * to avoid WebSocket/HTTP polling in static or demo contexts where there is no server.
 */

import { useState, useCallback, useRef } from 'react';
import type { ExternalAnnotationEvent } from '../types';
import {
  type DaemonSessionTransportMessage,
  useDaemonSessionTransport,
} from './useDaemonSessionTransport';
import { useSessionFetch } from './useSessionFetch';

const SNAPSHOT_URL = '/api/external-annotations';
const FALLBACK_POLL_MS = 2_000;

interface UseExternalAnnotationsReturn<T> {
  externalAnnotations: T[];
  updateExternalAnnotation: (id: string, updates: Partial<T>) => void;
  deleteExternalAnnotation: (id: string) => void;
  clearExternalAnnotations: (source?: string) => void;
}

interface ExternalAnnotationSnapshot<T> {
  annotations: T[];
  version?: number;
}

export function useExternalAnnotations<T extends { id: string; source?: string }>(
  options?: { enabled?: boolean },
): UseExternalAnnotationsReturn<T> {
  const fetch = useSessionFetch();
  const enabled = options?.enabled ?? true;
  const [annotations, setAnnotations] = useState<T[]>([]);
  const versionRef = useRef<number | null>(null);

  const applyEvent = useCallback((parsed: ExternalAnnotationEvent<T>) => {
    switch (parsed.type) {
      case 'snapshot':
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
  }, []);

  const fetchSnapshot = useCallback(async (): Promise<ExternalAnnotationSnapshot<T> | null> => {
    const version = versionRef.current;
    const url = version === null ? SNAPSHOT_URL : `${SNAPSHOT_URL}?since=${version}`;
    const res = await fetch(url);
    if (res.status === 304 || !res.ok) return null;
    const data = await res.json();
    if (!data || !Array.isArray(data.annotations)) return null;
    return data as ExternalAnnotationSnapshot<T>;
  }, []);

  const applySnapshot = useCallback((snapshot: ExternalAnnotationSnapshot<T>) => {
    setAnnotations(snapshot.annotations);
    if (typeof snapshot.version === 'number') versionRef.current = snapshot.version;
  }, []);

  const applyMessage = useCallback((message: DaemonSessionTransportMessage) => {
    const event = message.payload as ExternalAnnotationEvent<T>;
    if (event.type === 'snapshot' && typeof event.version === 'number') {
      versionRef.current = event.version;
    }
    applyEvent(event);
  }, [applyEvent]);

  useDaemonSessionTransport({
    enabled,
    family: 'external-annotations',
    pollMs: FALLBACK_POLL_MS,
    fetchSnapshot,
    applySnapshot,
    applyMessage,
  });

  const deleteExternalAnnotation = useCallback(async (id: string) => {
    // Optimistic update
    setAnnotations((prev) => prev.filter((a) => a.id !== id));
    try {
      await fetch(
        `${SNAPSHOT_URL}?id=${encodeURIComponent(id)}`,
        { method: 'DELETE' },
      );
    } catch {
      // Live updates or fallback snapshots will reconcile on next update
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
      // Live updates or fallback snapshots will reconcile on next update
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
      // Live updates or fallback snapshots will reconcile on next update
    }
  }, []);

  return { externalAnnotations: annotations, updateExternalAnnotation, deleteExternalAnnotation, clearExternalAnnotations };
}
