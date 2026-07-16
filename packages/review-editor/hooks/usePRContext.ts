import { useState, useRef, useCallback, useEffect } from 'react';
import type { PRContext } from '@plannotator/shared/pr-types';
import type { PRMetadata } from '@plannotator/shared/pr-types';
import type { PRContextStreamEvent } from '@plannotator/shared/pr-context-live';

const STREAM_URL = '/api/pr-context/stream';
const SNAPSHOT_URL = '/api/pr-context';
const POLL_INTERVAL_MS = 30_000;

export function usePRContext(prMetadata: PRMetadata | null) {
  const [prContext, setPRContext] = useState<PRContext | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const prUrl = prMetadata?.url;
  const lastUrl = useRef<string | undefined>(undefined);
  const contextRef = useRef<PRContext | null>(null);
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const receivedSnapshotRef = useRef(false);

  useEffect(() => {
    const url = prUrl;
    if (url !== lastUrl.current) {
      lastUrl.current = url;
      contextRef.current = null;
      receivedSnapshotRef.current = false;
      setPRContext(null);
      setIsLoading(url !== undefined);
      setError(null);
    }
  }, [prUrl]);

  const fetchContext = useCallback(async (): Promise<void> => {
    if (!prUrl) return;
    const requestUrl = prUrl;
    setIsLoading(true);

    try {
      const res = await fetch(SNAPSHOT_URL);
      if (requestUrl !== lastUrl.current) return;
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        const responseError =
          typeof data === 'object' &&
          data !== null &&
          'error' in data &&
          typeof data.error === 'string'
            ? data.error
            : `HTTP ${res.status}`;
        throw new Error(responseError);
      }
      const data: unknown = await res.json();
      const context = parsePRContext(data);
      if (!context) throw new Error('Invalid PR context response');
      if (requestUrl !== lastUrl.current) return;
      contextRef.current = context;
      setPRContext(context);
      setError(null);
    } catch (err) {
      if (requestUrl !== lastUrl.current) return;
      const message = err instanceof Error ? err.message : 'Failed to load PR context';
      setError(message);
    } finally {
      if (requestUrl === lastUrl.current) setIsLoading(false);
    }
  }, [prUrl]);

  useEffect(() => {
    if (!prUrl) return;

    const requestUrl = prUrl;
    let cancelled = false;
    let source: EventSource | null = null;

    const clearPolling = () => {
      if (pollTimerRef.current) {
        clearInterval(pollTimerRef.current);
        pollTimerRef.current = null;
      }
    };

    const applyEvent = (parsed: PRContextStreamEvent) => {
      if (cancelled || parsed.url !== requestUrl || requestUrl !== lastUrl.current) {
        return;
      }

      switch (parsed.type) {
        case 'snapshot':
          receivedSnapshotRef.current = true;
          if (parsed.context) {
            contextRef.current = parsed.context;
            setPRContext(parsed.context);
          }
          setIsLoading(parsed.loading && !parsed.context);
          setError(parsed.error);
          break;
        case 'loading':
          setIsLoading(contextRef.current === null);
          break;
        case 'updated':
          contextRef.current = parsed.context;
          setPRContext(parsed.context);
          setIsLoading(false);
          setError(null);
          break;
        case 'error':
          setIsLoading(false);
          setError(parsed.error);
          break;
      }
    };

    const startPolling = () => {
      if (cancelled || pollTimerRef.current) return;
      void fetchContext();
      pollTimerRef.current = setInterval(() => {
        void fetchContext();
      }, POLL_INTERVAL_MS);
    };

    if (typeof EventSource === 'undefined') {
      startPolling();
      return () => {
        cancelled = true;
        clearPolling();
      };
    }

    source = new EventSource(STREAM_URL);
    source.onmessage = (event) => {
      try {
        const raw: unknown = JSON.parse(event.data);
        const parsed = parsePRContextStreamEvent(raw);
        if (parsed) applyEvent(parsed);
      } catch {
        // Ignore malformed events and heartbeat comments.
      }
    };
    source.onerror = () => {
      if (!receivedSnapshotRef.current) {
        source?.close();
        source = null;
        startPolling();
      }
    };

    return () => {
      cancelled = true;
      source?.close();
      clearPolling();
    };
  }, [fetchContext, prUrl]);

  return { prContext, isLoading, error, fetchContext };
}

function parsePRContextStreamEvent(value: unknown): PRContextStreamEvent | null {
  if (!isRecord(value) || typeof value.type !== 'string') return null;
  if (typeof value.url !== 'string' || typeof value.version !== 'number') return null;

  switch (value.type) {
    case 'snapshot': {
      const context = value.context === null ? null : parsePRContext(value.context);
      if (value.context !== null && !context) return null;
      if (typeof value.loading !== 'boolean') return null;
      if (value.error !== null && typeof value.error !== 'string') return null;
      if (typeof value.stale !== 'boolean') return null;
      if (value.retryAt !== undefined && typeof value.retryAt !== 'number') return null;
      return {
        type: 'snapshot',
        url: value.url,
        version: value.version,
        context,
        loading: value.loading,
        error: value.error,
        stale: value.stale,
        ...(value.retryAt !== undefined ? { retryAt: value.retryAt } : {}),
      };
    }
    case 'updated': {
      const context = parsePRContext(value.context);
      if (!context || value.stale !== false) return null;
      return {
        type: 'updated',
        url: value.url,
        version: value.version,
        context,
        stale: false,
      };
    }
    case 'loading':
      return { type: 'loading', url: value.url, version: value.version };
    case 'error':
      if (typeof value.error !== 'string') return null;
      if (typeof value.stale !== 'boolean') return null;
      if (value.retryAt !== undefined && typeof value.retryAt !== 'number') return null;
      return {
        type: 'error',
        url: value.url,
        version: value.version,
        error: value.error,
        stale: value.stale,
        ...(value.retryAt !== undefined ? { retryAt: value.retryAt } : {}),
      };
    default:
      return null;
  }
}

function parsePRContext(value: unknown): PRContext | null {
  if (!isRecord(value)) return null;
  if (
    typeof value.body !== 'string' ||
    typeof value.state !== 'string' ||
    typeof value.isDraft !== 'boolean' ||
    typeof value.reviewDecision !== 'string' ||
    typeof value.mergeable !== 'string' ||
    typeof value.mergeStateStatus !== 'string' ||
    !isLabelArray(value.labels) ||
    !isCommentArray(value.comments) ||
    !isReviewArray(value.reviews) ||
    !isReviewThreadArray(value.reviewThreads) ||
    !isCheckArray(value.checks) ||
    !isLinkedIssueArray(value.linkedIssues)
  ) {
    return null;
  }

  return {
    body: value.body,
    state: value.state,
    isDraft: value.isDraft,
    labels: value.labels,
    reviewDecision: value.reviewDecision,
    mergeable: value.mergeable,
    mergeStateStatus: value.mergeStateStatus,
    comments: value.comments,
    reviews: value.reviews,
    reviewThreads: value.reviewThreads,
    checks: value.checks,
    linkedIssues: value.linkedIssues,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isLabelArray(value: unknown): value is PRContext['labels'] {
  return Array.isArray(value) && value.every((item) =>
    isRecord(item) &&
    typeof item.name === 'string' &&
    typeof item.color === 'string'
  );
}

function isCommentArray(value: unknown): value is PRContext['comments'] {
  return Array.isArray(value) && value.every((item) =>
    isRecord(item) &&
    typeof item.id === 'string' &&
    typeof item.author === 'string' &&
    typeof item.body === 'string' &&
    typeof item.createdAt === 'string' &&
    typeof item.url === 'string'
  );
}

function isReviewArray(value: unknown): value is PRContext['reviews'] {
  return Array.isArray(value) && value.every((item) =>
    isRecord(item) &&
    typeof item.id === 'string' &&
    typeof item.author === 'string' &&
    typeof item.state === 'string' &&
    typeof item.body === 'string' &&
    typeof item.submittedAt === 'string' &&
    (item.url === undefined || typeof item.url === 'string')
  );
}

function isReviewThreadArray(value: unknown): value is PRContext['reviewThreads'] {
  return Array.isArray(value) && value.every((item) =>
    isRecord(item) &&
    typeof item.id === 'string' &&
    typeof item.isResolved === 'boolean' &&
    typeof item.isOutdated === 'boolean' &&
    typeof item.path === 'string' &&
    (typeof item.line === 'number' || item.line === null) &&
    (typeof item.startLine === 'number' || item.startLine === null) &&
    (item.diffSide === 'LEFT' || item.diffSide === 'RIGHT' || item.diffSide === null) &&
    isThreadCommentArray(item.comments)
  );
}

function isThreadCommentArray(value: unknown): value is PRContext['reviewThreads'][number]['comments'] {
  return Array.isArray(value) && value.every((item) =>
    isRecord(item) &&
    typeof item.id === 'string' &&
    typeof item.author === 'string' &&
    typeof item.body === 'string' &&
    typeof item.createdAt === 'string' &&
    typeof item.url === 'string' &&
    (item.diffHunk === undefined || typeof item.diffHunk === 'string')
  );
}

function isCheckArray(value: unknown): value is PRContext['checks'] {
  return Array.isArray(value) && value.every((item) =>
    isRecord(item) &&
    typeof item.name === 'string' &&
    typeof item.status === 'string' &&
    (typeof item.conclusion === 'string' || item.conclusion === null) &&
    typeof item.workflowName === 'string' &&
    typeof item.detailsUrl === 'string'
  );
}

function isLinkedIssueArray(value: unknown): value is PRContext['linkedIssues'] {
  return Array.isArray(value) && value.every((item) =>
    isRecord(item) &&
    typeof item.number === 'number' &&
    typeof item.url === 'string' &&
    typeof item.repo === 'string'
  );
}
