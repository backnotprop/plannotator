import { useState, useCallback, useEffect } from 'react';
import type { Annotation, ImageAttachment, ReviewSession } from '../types';

interface UseCollaborativeSessionResult {
  /** Whether this is an active collaborative session */
  isCollaborativeSession: boolean;

  /** Session ID (empty if not collaborative) */
  sessionId: string;

  /** Current session version (for optimistic locking) */
  sessionVersion: number;

  /** Loading state */
  isLoading: boolean;

  /** Error message */
  error: string;

  /** Create a new collaborative session and get share URL */
  createSession: () => Promise<string | null>;

  /** Join an existing session by ID */
  joinSession: (sessionId: string) => Promise<boolean>;

  /** Submit annotations to the session (incremental) */
  submitAnnotations: (
    annotations: Annotation[],
    globalAttachments?: ImageAttachment[]
  ) => Promise<boolean>;

  /** Refresh session to get latest annotations from other reviewers */
  refreshSession: () => Promise<boolean>;

  /** Number of reviewers in session */
  reviewerCount: number;

  /** Last update timestamp */
  lastUpdatedAt: number;
}

export function useCollaborativeSession(
  markdown: string,
  setAnnotations: React.Dispatch<React.SetStateAction<Annotation[]>>,
  setGlobalAttachments: React.Dispatch<React.SetStateAction<ImageAttachment[]>>,
  pasteApiUrl?: string
): UseCollaborativeSessionResult {
  const [isCollaborativeSession, setIsCollaborativeSession] = useState(false);
  const [sessionId, setSessionId] = useState('');
  const [sessionVersion, setSessionVersion] = useState(0);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');
  const [reviewerCount, setReviewerCount] = useState(0);
  const [lastUpdatedAt, setLastUpdatedAt] = useState(0);

  const apiBase = pasteApiUrl || 'https://plannotator-paste.plannotator.workers.dev';

  const createSession = useCallback(async (): Promise<string | null> => {
    setIsLoading(true);
    setError('');

    try {
      const response = await fetch(`${apiBase}/api/review-session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ plan: markdown }),
        signal: AbortSignal.timeout(10_000),
      });

      if (!response.ok) {
        const errData = await response.json().catch(() => ({ error: 'Failed to create session' }));
        setError(errData.error || 'Failed to create session');
        return null;
      }

      const { session, shareUrl } = await response.json();

      setIsCollaborativeSession(true);
      setSessionId(session.id);
      setSessionVersion(session.version);
      setReviewerCount(session.reviewerCount);
      setLastUpdatedAt(session.lastUpdatedAt);

      return shareUrl;
    } catch (e) {
      setError('Network error while creating session');
      return null;
    } finally {
      setIsLoading(false);
    }
  }, [markdown, apiBase]);

  const joinSession = useCallback(
    async (id: string): Promise<boolean> => {
      setIsLoading(true);
      setError('');

      try {
        const response = await fetch(`${apiBase}/api/review-session/${id}`, {
          signal: AbortSignal.timeout(10_000),
        });

        if (!response.ok) {
          setError('Session not found or expired');
          return false;
        }

        const { session } = await response.json();

        setIsCollaborativeSession(true);
        setSessionId(session.id);
        setSessionVersion(session.version);
        setReviewerCount(session.reviewerCount);
        setLastUpdatedAt(session.lastUpdatedAt);

        // Load session state into UI
        setAnnotations(session.annotations);
        if (session.globalAttachments?.length) {
          setGlobalAttachments(session.globalAttachments);
        }

        return true;
      } catch {
        setError('Failed to join session');
        return false;
      } finally {
        setIsLoading(false);
      }
    },
    [apiBase, setAnnotations, setGlobalAttachments]
  );

  const submitAnnotations = useCallback(
    async (annotations: Annotation[], globalAttachments?: ImageAttachment[]): Promise<boolean> => {
      if (!isCollaborativeSession) return false;

      setIsLoading(true);
      setError('');

      try {
        const response = await fetch(`${apiBase}/api/review-session/${sessionId}/annotations`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            annotations,
            globalAttachments,
            expectedVersion: sessionVersion,
          }),
          signal: AbortSignal.timeout(10_000),
        });

        if (!response.ok) {
          if (response.status === 409) {
            setError('Session was updated by another reviewer — refreshing...');
            // Auto-refresh on conflict
            await refreshSession();
          } else {
            const errData = await response.json().catch(() => ({ error: 'Failed to submit' }));
            setError(errData.error || 'Failed to submit annotations');
          }
          return false;
        }

        const { session } = await response.json();

        setSessionVersion(session.version);
        setReviewerCount(session.reviewerCount);
        setLastUpdatedAt(session.lastUpdatedAt);

        return true;
      } catch {
        setError('Network error while submitting annotations');
        return false;
      } finally {
        setIsLoading(false);
      }
    },
    [isCollaborativeSession, sessionId, sessionVersion, apiBase]
  );

  const refreshSession = useCallback(async (): Promise<boolean> => {
    if (!isCollaborativeSession) return false;

    setIsLoading(true);
    setError('');

    try {
      const response = await fetch(`${apiBase}/api/review-session/${sessionId}`, {
        signal: AbortSignal.timeout(10_000),
      });

      if (!response.ok) {
        setError('Failed to refresh session');
        return false;
      }

      const { session } = await response.json();

      setSessionVersion(session.version);
      setReviewerCount(session.reviewerCount);
      setLastUpdatedAt(session.lastUpdatedAt);

      // Merge annotations (keep local state, add new ones from server)
      setAnnotations((prev) => {
        const merged = [...prev];
        const existingSet = new Set(merged.map((a) => `${a.originalText}|${a.type}|${a.text || ''}`));

        const newFromServer = session.annotations.filter((ann: Annotation) => {
          const key = `${ann.originalText}|${ann.type}|${ann.text || ''}`;
          return !existingSet.has(key);
        });

        return [...merged, ...newFromServer];
      });

      if (session.globalAttachments?.length) {
        setGlobalAttachments((prev) => {
          const existingPaths = new Set(prev.map((g) => g.path));
          const newAttachments = session.globalAttachments.filter((g: ImageAttachment) => !existingPaths.has(g.path));
          return [...prev, ...newAttachments];
        });
      }

      return true;
    } catch {
      setError('Failed to refresh session');
      return false;
    } finally {
      setIsLoading(false);
    }
  }, [isCollaborativeSession, sessionId, apiBase, setAnnotations, setGlobalAttachments]);

  // Check URL for /s/<id> pattern on mount
  useEffect(() => {
    const pathMatch = window.location.pathname.match(/^\/s\/([A-Za-z0-9]{6,16})$/);
    if (pathMatch) {
      const id = pathMatch[1];
      joinSession(id).then((success) => {
        if (success) {
          // Clean up URL
          window.history.replaceState({}, '', '/');
        }
      });
    }
  }, [joinSession]);

  return {
    isCollaborativeSession,
    sessionId,
    sessionVersion,
    isLoading,
    error,
    createSession,
    joinSession,
    submitAnnotations,
    refreshSession,
    reviewerCount,
    lastUpdatedAt,
  };
}
