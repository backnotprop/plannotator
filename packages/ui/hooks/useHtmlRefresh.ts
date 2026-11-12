import { useCallback, useLayoutEffect, useRef, useState } from 'react';

export type HtmlRefreshOkSnapshot<Extra extends object = object> = { status: 'ok'; rawHtml: string } & Extra;

export type HtmlRefreshSnapshot<Extra extends object = object> =
  | HtmlRefreshOkSnapshot<Extra>
  | { status: 'missing' }
  | { status: 'unavailable' };

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
