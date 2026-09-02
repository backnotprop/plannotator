import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  CodeNavHoverResponse,
  CodeNavRequest,
} from '@plannotator/shared/code-nav';

export type { CodeNavHoverResponse };

/** Dwell before any request exists. Sweeping a diff costs zero rg processes. */
const DWELL_MS = 350;
/** Grace on leave, so the card's own links are reachable. */
const LEAVE_GRACE_MS = 250;
const MAX_CACHE_ENTRIES = 30;

export interface TokenHoverState {
  request: CodeNavRequest;
  data: CodeNavHoverResponse;
  /** Anchor geometry captured when the card opened. */
  rect: DOMRect;
}

export interface UseTokenHoverResult {
  hover: TokenHoverState | null;
  /** Wire to the diff views' `onTokenHoverEnter`. */
  onTokenHoverEnter: (request: CodeNavRequest, tokenElement: HTMLElement) => void;
  /** Wire to the diff views' `onTokenHoverLeave`. */
  onTokenHoverLeave: () => void;
  /** Pointer entered the card: cancel the pending close. */
  onCardEnter: () => void;
  /** Pointer left the card: restart the close timer. */
  onCardLeave: () => void;
  /** Close now and abandon anything pending (gate flips, submission, unmount). */
  close: () => void;
}

function cacheKey(request: CodeNavRequest): string {
  return `${request.symbol}|${request.filePath}|${request.side}`;
}

/**
 * A response is worth a card only when it says something. One stray reference
 * is noise, and an empty card flashing on every hover is worse than no card.
 */
function meetsRenderThreshold(data: CodeNavHoverResponse): boolean {
  if (data.backend !== 'search') return false;
  return data.definition != null || data.references.length >= 2;
}

/**
 * Token hover cards over POST /api/code-nav/hover.
 *
 * Every failure mode resolves to "no card": an unavailable backend, a non-OK
 * response, a timeout, an abort, and a below-threshold answer all render
 * nothing, silently. A hover is an idle gesture and must never nag — the toast
 * belongs to Cmd+click, which is a deliberate action.
 *
 * @param snapshotId the active diff snapshot; a change flushes the cache so a
 *   refreshed diff can never serve positions from the diff before it.
 */
export function useTokenHover(snapshotId?: string): UseTokenHoverResult {
  const [hover, setHover] = useState<TokenHoverState | null>(null);
  // Drives the scroll listener: a document-level listener exists only while
  // something is actually pending or open.
  const [engaged, setEngaged] = useState(false);

  const dwellTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const graceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const activeKeyRef = useRef<string | null>(null);
  const openKeyRef = useRef<string | null>(null);
  const cacheRef = useRef(new Map<string, CodeNavHoverResponse>());

  const clearDwell = useCallback(() => {
    if (dwellTimerRef.current) clearTimeout(dwellTimerRef.current);
    dwellTimerRef.current = null;
  }, []);

  const clearGrace = useCallback(() => {
    if (graceTimerRef.current) clearTimeout(graceTimerRef.current);
    graceTimerRef.current = null;
  }, []);

  const close = useCallback(() => {
    clearDwell();
    clearGrace();
    abortRef.current?.abort();
    abortRef.current = null;
    activeKeyRef.current = null;
    openKeyRef.current = null;
    setHover(null);
    setEngaged(false);
  }, [clearDwell, clearGrace]);

  const readCache = useCallback((key: string): CodeNavHoverResponse | undefined => {
    const cache = cacheRef.current;
    const cached = cache.get(key);
    if (cached) {
      // Refresh recency.
      cache.delete(key);
      cache.set(key, cached);
    }
    return cached;
  }, []);

  const writeCache = useCallback((key: string, data: CodeNavHoverResponse) => {
    const cache = cacheRef.current;
    if (cache.size >= MAX_CACHE_ENTRIES) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    cache.set(key, data);
  }, []);

  const open = useCallback(
    (key: string, request: CodeNavRequest, data: CodeNavHoverResponse, element: HTMLElement) => {
      if (!meetsRenderThreshold(data)) {
        // Nothing to show. Stay quiet and stop holding the scroll listener.
        if (openKeyRef.current == null) setEngaged(false);
        return;
      }
      openKeyRef.current = key;
      setHover({ request, data, rect: element.getBoundingClientRect() });
    },
    [],
  );

  const onTokenHoverEnter = useCallback(
    (request: CodeNavRequest, tokenElement: HTMLElement) => {
      clearGrace();
      const key = cacheKey(request);

      // Crossing between fragments of the same identifier fires leave+enter.
      // Keep the open card and its anchor exactly where they are.
      if (openKeyRef.current === key) return;

      clearDwell();
      if (activeKeyRef.current !== key) {
        abortRef.current?.abort();
        abortRef.current = null;
      }
      activeKeyRef.current = key;
      setEngaged(true);

      dwellTimerRef.current = setTimeout(() => {
        dwellTimerRef.current = null;
        if (activeKeyRef.current !== key) return;

        const cached = readCache(key);
        if (cached) {
          open(key, request, cached, tokenElement);
          return;
        }

        const controller = new AbortController();
        abortRef.current = controller;
        void (async () => {
          try {
            const res = await fetch('/api/code-nav/hover', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(request),
              signal: controller.signal,
            });
            if (!res.ok) return;
            const data = (await res.json()) as CodeNavHoverResponse;
            if (controller.signal.aborted || activeKeyRef.current !== key) return;
            writeCache(key, data);
            open(key, request, data, tokenElement);
          } catch {
            // Aborts, network failures and malformed answers are all "no card".
          } finally {
            if (abortRef.current === controller) abortRef.current = null;
          }
        })();
      }, DWELL_MS);
    },
    [clearDwell, clearGrace, open, readCache, writeCache],
  );

  const startGrace = useCallback(() => {
    clearGrace();
    graceTimerRef.current = setTimeout(() => {
      graceTimerRef.current = null;
      close();
    }, LEAVE_GRACE_MS);
  }, [clearGrace, close]);

  const onTokenHoverLeave = useCallback(() => {
    // The dwell dies with the pointer; the in-flight fetch does not, so a
    // re-entry inside the grace window still lands its own answer.
    clearDwell();
    startGrace();
  }, [clearDwell, startGrace]);

  const onCardEnter = useCallback(() => clearGrace(), [clearGrace]);
  const onCardLeave = useCallback(() => startGrace(), [startGrace]);

  // The anchor rect is stale the moment the pane moves, so scrolling closes the
  // card and abandons the pending fetch. Capture phase, because the scroll
  // happens inside the diff pane, not on the document.
  useEffect(() => {
    if (!engaged) return;
    const cancel = () => close();
    document.addEventListener('scroll', cancel, true);
    document.addEventListener('wheel', cancel, { capture: true, passive: true });
    return () => {
      document.removeEventListener('scroll', cancel, true);
      document.removeEventListener('wheel', cancel, true);
    };
  }, [engaged, close]);

  // A new diff snapshot invalidates every cached position.
  useEffect(() => {
    cacheRef.current.clear();
    close();
  }, [snapshotId, close]);

  useEffect(() => close, [close]);

  return {
    hover,
    onTokenHoverEnter,
    onTokenHoverLeave,
    onCardEnter,
    onCardLeave,
    close,
  };
}
