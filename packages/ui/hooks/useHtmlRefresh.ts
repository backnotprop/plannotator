import { useCallback, useLayoutEffect, useRef, useState } from 'react';

/**
 * A successful snapshot. `Extra` lets a host carry document metadata read
 * alongside the bytes (Plannotator: the root document's version diff) through
 * to `onSnapshot`; the hook never reads anything but `rawHtml`.
 */
export type HtmlRefreshOkSnapshot<Extra extends object = object> = { status: 'ok'; rawHtml: string } & Extra;

/** What a host's `fetchSnapshot` resolves to. */
export type HtmlRefreshSnapshot<Extra extends object = object> =
  | HtmlRefreshOkSnapshot<Extra>
  | { status: 'missing' }
  | { status: 'unavailable' };

/** The outcome of one `refresh()` call, for host notifications (toasts). */
export type HtmlRefreshResult = 'refreshed' | 'missing' | 'unavailable';

export interface UseHtmlRefreshOptions<Extra extends object = object> {
  /** Whether refresh is offered at all. Default true. */
  enabled?: boolean;
  /**
   * Identity of the document under refresh (a path, an id). A change
   * cancels any in-flight fetch and any pending restore acknowledgement, so
   * a snapshot for the previous document can never land on the next one.
   * `null` means no document: `canRefresh` is false. Omit it when the host
   * has a single document.
   */
  documentKey?: string | null;
  /** Fetch the current bytes of the document. Called with `documentKey`.
   *  A rejection is treated as `{ status: 'unavailable' }`. */
  fetchSnapshot: (documentKey: string | null) => Promise<HtmlRefreshSnapshot<Extra>>;
  /** Apply the refreshed bytes (the host owns the viewer's `rawHtml`). The
   *  whole successful snapshot is the second argument, for hosts whose
   *  `fetchSnapshot` reads metadata alongside the bytes. */
  onSnapshot: (rawHtml: string, snapshot: HtmlRefreshOkSnapshot<Extra>) => void;
  /**
   * Once per refresh: the ids the remounted viewer could not re-anchor,
   * possibly empty. Wire the viewer's `onUnanchoredChange` to the returned
   * `reportAnnotationRestore`; only the first report after a refresh is
   * forwarded, and only while the document and reload generation match.
   */
  onUnanchored?: (ids: string[]) => void;
  /** The outcome of each `refresh()` call that reached a decision. */
  onResult?: (result: HtmlRefreshResult) => void;
}

export interface UseHtmlRefreshReturn {
  canRefresh: boolean;
  isRefreshing: boolean;
  /** Bumps after every applied snapshot. Key the viewer on it to remount. */
  reloadGeneration: number;
  refresh: () => Promise<void>;
  /** Feed the viewer's `onUnanchoredChange` report here. */
  reportAnnotationRestore: (missingIds: string[]) => void;
}

/**
 * Re-fetch a rendered HTML document from the host's source and remount the
 * viewer on it, keeping the annotations the viewer can still anchor.
 *
 * Backend-agnostic: the host supplies `fetchSnapshot` (Plannotator wraps its
 * `/api/doc` read; a host with a document store passes its own read). The
 * hook owns the guards: an in-flight fetch that is superseded by a newer
 * refresh, or by a document change, is dropped before `onSnapshot`; the
 * restore acknowledgement is armed per reload generation and consumed by
 * the first viewer report for that generation.
 */
export function useHtmlRefresh<Extra extends object = object>({
  enabled = true,
  documentKey,
  fetchSnapshot,
  onSnapshot,
  onUnanchored,
  onResult,
}: UseHtmlRefreshOptions<Extra>): UseHtmlRefreshReturn {
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [reloadGeneration, setReloadGeneration] = useState(0);
  const keyed = documentKey !== undefined;
  const activeKey = keyed ? documentKey : null;
  const activeKeyRef = useRef(activeKey);
  const requestRef = useRef(0);
  const reloadGenerationRef = useRef(0);
  const restorePendingRef = useRef<{ key: string | null; generation: number } | null>(null);
  const onUnanchoredRef = useRef(onUnanchored);
  onUnanchoredRef.current = onUnanchored;
  const onResultRef = useRef(onResult);
  onResultRef.current = onResult;
  const canRefresh = enabled && (!keyed || !!documentKey);

  useLayoutEffect(() => {
    if (activeKeyRef.current !== activeKey) {
      requestRef.current += 1;
      restorePendingRef.current = null;
      setIsRefreshing(false);
    }
    activeKeyRef.current = activeKey;
  }, [activeKey]);

  const refresh = useCallback(async () => {
    if (!canRefresh) return;

    const requestKey = activeKey;
    const requestId = ++requestRef.current;
    setIsRefreshing(true);
    try {
      // A rejecting fetch is an unavailable snapshot: the host hears it
      // through onResult like any other outcome, never as an unhandled
      // rejection out of refresh().
      let result: HtmlRefreshSnapshot<Extra>;
      try {
        result = await fetchSnapshot(requestKey);
      } catch {
        result = { status: 'unavailable' };
      }
      if (requestId !== requestRef.current || activeKeyRef.current !== requestKey) return;

      if (result.status === 'missing' || result.status === 'unavailable') {
        onResultRef.current?.(result.status);
        return;
      }

      onSnapshot(result.rawHtml, result);
      const nextGeneration = reloadGenerationRef.current + 1;
      reloadGenerationRef.current = nextGeneration;
      // Armed until the remounted viewer's bridge reports its restore. The
      // bridge emits "unanchored" only when the set CHANGES from its initial
      // empty state, so a pass that restores everything never posts and this
      // stays armed; that is harmless because the next refresh replaces it
      // and a document change clears it.
      restorePendingRef.current = { key: requestKey, generation: nextGeneration };
      setReloadGeneration(nextGeneration);
      onResultRef.current?.('refreshed');
    } finally {
      if (requestId === requestRef.current) setIsRefreshing(false);
    }
  }, [activeKey, canRefresh, fetchSnapshot, onSnapshot]);

  const reportAnnotationRestore = useCallback((missingIds: string[]) => {
    const pending = restorePendingRef.current;
    if (
      !pending ||
      pending.key !== activeKeyRef.current ||
      pending.generation !== reloadGenerationRef.current
    ) return;

    restorePendingRef.current = null;
    onUnanchoredRef.current?.(missingIds);
  }, []);

  return {
    canRefresh,
    isRefreshing,
    reloadGeneration,
    refresh,
    reportAnnotationRestore,
  };
}
