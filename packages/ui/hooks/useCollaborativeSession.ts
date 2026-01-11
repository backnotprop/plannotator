/**
 * Hook for real-time collaborative sessions
 *
 * Manages Supabase subscriptions and annotation sync for collaborative editing.
 * Automatically syncs annotation changes to all connected clients.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { Annotation, SyncStatus, CollaborativeSession } from '../types';
import { getSupabase, DbAnnotation, RealtimeChannel } from '../lib/supabase';
import {
  fetchSession,
  fetchSessionAnnotations,
  addSessionAnnotation,
  removeSessionAnnotation,
  parseSessionFromUrl,
  getSessionUrl,
  createSession,
  isCollaborativeAvailable,
} from '../utils/sessionSharing';

interface UseCollaborativeSessionResult {
  /** Current session ID (null if not in a session) */
  sessionId: string | null;

  /** Whether collaborative features are available */
  isCollaborativeAvailable: boolean;

  /** Current sync status */
  syncStatus: SyncStatus;

  /** Error message if sync failed */
  syncError: string | null;

  /** Session URL for sharing */
  sessionUrl: string | null;

  /** Create a new collaborative session from the current plan */
  createCollaborativeSession: (planMarkdown: string) => Promise<string | null>;

  /** Add an annotation and sync to server */
  syncAddAnnotation: (annotation: Annotation) => Promise<boolean>;

  /** Remove an annotation and sync to server */
  syncRemoveAnnotation: (annotationId: string) => Promise<boolean>;

  /** Annotations that were added remotely (need to be applied to DOM) */
  pendingRemoteAnnotations: Annotation[];

  /** IDs of annotations that were removed remotely */
  pendingRemoteRemovals: string[];

  /** Clear pending remote changes after applying */
  clearPendingRemote: () => void;
}

export function useCollaborativeSession(
  setMarkdown: (m: string) => void,
  localAnnotations: Annotation[],
  setAnnotations: (a: Annotation[]) => void
): UseCollaborativeSessionResult {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [syncStatus, setSyncStatus] = useState<SyncStatus>('disconnected');
  const [syncError, setSyncError] = useState<string | null>(null);
  const [pendingRemoteAnnotations, setPendingRemoteAnnotations] = useState<Annotation[]>([]);
  const [pendingRemoteRemovals, setPendingRemoteRemovals] = useState<string[]>([]);

  const channelRef = useRef<RealtimeChannel | null>(null);
  const localAnnotationIdsRef = useRef<Set<string>>(new Set());

  // Track local annotation IDs to distinguish local vs remote changes
  useEffect(() => {
    localAnnotationIdsRef.current = new Set(localAnnotations.map(a => a.id));
  }, [localAnnotations]);

  // Check for session in URL on mount
  useEffect(() => {
    const urlSessionId = parseSessionFromUrl();
    if (urlSessionId) {
      loadSession(urlSessionId);
    }
  }, []);

  // Load an existing session
  const loadSession = useCallback(async (id: string) => {
    setSyncStatus('connecting');
    setSyncError(null);

    try {
      const session = await fetchSession(id);
      if (!session) {
        setSyncStatus('error');
        setSyncError('Session not found');
        return;
      }

      // Set the plan content
      setMarkdown(session.planMarkdown);

      // Fetch existing annotations
      const annotations = await fetchSessionAnnotations(id);
      if (annotations.length > 0) {
        setAnnotations(annotations);
        setPendingRemoteAnnotations(annotations);
      }

      setSessionId(id);
      subscribeToSession(id);
      setSyncStatus('connected');
    } catch (e) {
      console.error('Failed to load session:', e);
      setSyncStatus('error');
      setSyncError('Failed to load session');
    }
  }, [setMarkdown, setAnnotations]);

  // Subscribe to real-time updates for a session
  const subscribeToSession = useCallback((id: string) => {
    const supabase = getSupabase();
    if (!supabase) return;

    // Unsubscribe from any existing channel
    if (channelRef.current) {
      channelRef.current.unsubscribe();
    }

    const channel = supabase
      .channel(`session:${id}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'annotations',
          filter: `session_id=eq.${id}`,
        },
        (payload) => {
          handleRealtimeChange(payload);
        }
      )
      .subscribe((status) => {
        if (status === 'SUBSCRIBED') {
          setSyncStatus('connected');
        } else if (status === 'CHANNEL_ERROR') {
          setSyncStatus('error');
          setSyncError('Real-time connection failed');
        }
      });

    channelRef.current = channel;
  }, []);

  // Handle real-time database changes
  const handleRealtimeChange = useCallback((payload: { eventType: string; new?: unknown; old?: unknown }) => {
    const { eventType } = payload;
    const newRecord = payload.new as DbAnnotation | undefined;
    const oldRecord = payload.old as DbAnnotation | undefined;

    if (eventType === 'INSERT' && newRecord) {
      // Skip if this is our own annotation
      if (localAnnotationIdsRef.current.has(newRecord.id)) {
        return;
      }

      const annotation = dbAnnotationToAnnotation(newRecord);
      setPendingRemoteAnnotations(prev => [...prev, annotation]);
      setAnnotations(prev => {
        // Avoid duplicates
        if (prev.some(a => a.id === annotation.id)) {
          return prev;
        }
        return [...prev, annotation];
      });
    }

    if (eventType === 'UPDATE' && newRecord?.deleted_at) {
      // Soft delete - remove from local state
      if (!localAnnotationIdsRef.current.has(newRecord.id)) {
        setPendingRemoteRemovals(prev => [...prev, newRecord.id]);
        setAnnotations(prev => prev.filter(a => a.id !== newRecord.id));
      }
    }

    if (eventType === 'DELETE' && oldRecord) {
      // Hard delete
      if (!localAnnotationIdsRef.current.has(oldRecord.id)) {
        setPendingRemoteRemovals(prev => [...prev, oldRecord.id]);
        setAnnotations(prev => prev.filter(a => a.id !== oldRecord.id));
      }
    }
  }, [setAnnotations]);

  // Create a new collaborative session
  const createCollaborativeSession = useCallback(async (planMarkdown: string): Promise<string | null> => {
    setSyncStatus('connecting');
    setSyncError(null);

    try {
      const newSessionId = await createSession(planMarkdown);
      if (!newSessionId) {
        setSyncStatus('error');
        setSyncError('Failed to create session');
        return null;
      }

      setSessionId(newSessionId);
      subscribeToSession(newSessionId);
      setSyncStatus('connected');

      // Update URL to session URL (without reload)
      const newUrl = `/session/${newSessionId}`;
      window.history.pushState({}, '', newUrl);

      return newSessionId;
    } catch (e) {
      console.error('Failed to create session:', e);
      setSyncStatus('error');
      setSyncError('Failed to create session');
      return null;
    }
  }, [subscribeToSession]);

  // Add annotation and sync to server
  const syncAddAnnotation = useCallback(async (annotation: Annotation): Promise<boolean> => {
    if (!sessionId) return false;

    setSyncStatus('syncing');
    const success = await addSessionAnnotation(sessionId, annotation);
    setSyncStatus(success ? 'connected' : 'error');

    if (!success) {
      setSyncError('Failed to sync annotation');
    }

    return success;
  }, [sessionId]);

  // Remove annotation and sync to server
  const syncRemoveAnnotation = useCallback(async (annotationId: string): Promise<boolean> => {
    if (!sessionId) return false;

    setSyncStatus('syncing');
    const success = await removeSessionAnnotation(annotationId);
    setSyncStatus(success ? 'connected' : 'error');

    if (!success) {
      setSyncError('Failed to remove annotation');
    }

    return success;
  }, [sessionId]);

  // Clear pending remote changes
  const clearPendingRemote = useCallback(() => {
    setPendingRemoteAnnotations([]);
    setPendingRemoteRemovals([]);
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (channelRef.current) {
        channelRef.current.unsubscribe();
      }
    };
  }, []);

  return {
    sessionId,
    isCollaborativeAvailable: isCollaborativeAvailable(),
    syncStatus,
    syncError,
    sessionUrl: sessionId ? getSessionUrl(sessionId) : null,
    createCollaborativeSession,
    syncAddAnnotation,
    syncRemoveAnnotation,
    pendingRemoteAnnotations,
    pendingRemoteRemovals,
    clearPendingRemote,
  };
}

// Helper to convert DB annotation to app annotation
function dbAnnotationToAnnotation(db: DbAnnotation): Annotation {
  const typeMap: Record<string, string> = {
    'DELETION': 'DELETION',
    'REPLACEMENT': 'REPLACEMENT',
    'COMMENT': 'COMMENT',
    'INSERTION': 'INSERTION',
    'GLOBAL_COMMENT': 'GLOBAL_COMMENT',
  };

  return {
    id: db.id,
    blockId: '',
    startOffset: 0,
    endOffset: 0,
    type: typeMap[db.type] as Annotation['type'],
    text: db.text || undefined,
    originalText: db.original_text,
    createdA: new Date(db.created_at).getTime(),
    author: db.author || undefined,
    imagePaths: db.image_paths || undefined,
  };
}
