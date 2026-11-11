import { useCallback, useLayoutEffect, useRef, useState } from 'react';

/** A successful snapshot. */
export type HtmlRefreshOkSnapshot<Extra extends object = object> = { status: 'ok'; rawHtml: string } & Extra;

export type HtmlRefreshSnapshot<Extra extends object = object> =
  | HtmlRefreshOkSnapshot<Extra>
  | { status: 'missing' }
  | { status: 'unavailable' };

/** The outcome of one `refresh()` call, for host notifications (toasts). */
export type HtmlRefreshResult = 'refreshed' | 'missing' | 'unavailable';

export interface UseHtmlRefreshOptions<Extra extends object = object> {
  enabled?: boolean;
  documentKey?: string | null;
  fetchSnapshot: (documentKey: string | null) => Promise<HtmlRefreshSnapshot<Extra>>;
  onSnapshot: (rawHtml: string, snapshot: HtmlRefreshOkSnapshot<Extra>) => void;
  onUnanchored?: (ids: string[]) => void;
  onResult?: (result: HtmlRefreshResult) => void;
}

export interface UseHtmlRefreshReturn {
  canRefresh: boolean;
  isRefreshing: boolean;
  reloadGeneration: number;
  refresh: () => Promise<void>;
  reportAnnotationRestore: (missingIds: string[]) => void;
}

/**
 * Re-fetch a rendered HTML document from the host's source and remount the viewer on it, keeping
 * the annotations the viewer can still anchor.
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
      // A rejecting fetch is an unavailable snapshot: the host hears it through onResult like any
      // other outcome, never as an unhandled rejection out of refresh().
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
      // The bridge emits "unanchored" only when the set CHANGES from its initial empty state, so a
      // pass that restores everything never posts and this stays armed; that is harmless because
      // the next refresh replaces it and a document change clears it.
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
