import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { fetchHtmlDocumentSnapshot } from '../sourceDocumentClient';

interface UseHtmlRefreshOptions {
  enabled: boolean;
  activePath: string | null;
  onSnapshot: (rawHtml: string) => void;
}

interface UseHtmlRefreshResult {
  canRefresh: boolean;
  isRefreshing: boolean;
  reloadGeneration: number;
  refresh: () => Promise<void>;
  reportAnnotationRestore: (missingIds: string[]) => void;
}

export function useHtmlRefresh({
  enabled,
  activePath,
  onSnapshot,
}: UseHtmlRefreshOptions): UseHtmlRefreshResult {
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [reloadGeneration, setReloadGeneration] = useState(0);
  const activePathRef = useRef(activePath);
  const requestRef = useRef(0);
  const reloadGenerationRef = useRef(0);
  const restorePendingRef = useRef<{ path: string; generation: number } | null>(null);
  const canRefresh = enabled && !!activePath && !/^https?:\/\//i.test(activePath);

  useLayoutEffect(() => {
    if (activePathRef.current !== activePath) {
      requestRef.current += 1;
      restorePendingRef.current = null;
      setIsRefreshing(false);
    }
    activePathRef.current = activePath;
  }, [activePath]);

  const refresh = useCallback(async () => {
    if (!canRefresh || !activePath) return;

    const requestPath = activePath;
    const requestId = ++requestRef.current;
    setIsRefreshing(true);
    try {
      const result = await fetchHtmlDocumentSnapshot(requestPath);
      if (requestId !== requestRef.current || activePathRef.current !== requestPath) return;

      if (result.status === 'missing') {
        toast.error('HTML file no longer exists', {
          description: 'The current rendered version remains open.',
        });
        return;
      }
      if (result.status === 'unavailable') {
        toast.error('Could not refresh HTML', {
          description: 'The current rendered version remains open. Try again in a moment.',
        });
        return;
      }

      onSnapshot(result.snapshot.rawHtml);
      const nextGeneration = reloadGenerationRef.current + 1;
      reloadGenerationRef.current = nextGeneration;
      // Armed until the remounted viewer's bridge reports its restore. The
      // bridge emits "unanchored" only when the set CHANGES from its initial
      // empty state, so a pass that restores everything never posts and this
      // stays armed; that is harmless because the next refresh replaces it
      // and a path change clears it.
      restorePendingRef.current = { path: requestPath, generation: nextGeneration };
      setReloadGeneration(nextGeneration);
      toast.success('Refreshed HTML from disk');
    } finally {
      if (requestId === requestRef.current) setIsRefreshing(false);
    }
  }, [activePath, canRefresh, onSnapshot]);

  const reportAnnotationRestore = useCallback((missingIds: string[]) => {
    const pending = restorePendingRef.current;
    if (
      !pending ||
      pending.path !== activePathRef.current ||
      pending.generation !== reloadGenerationRef.current
    ) return;

    restorePendingRef.current = null;
    if (missingIds.length === 0) return;
    toast(`${missingIds.length} annotation${missingIds.length === 1 ? ' no longer matches' : 's no longer match'} the HTML`, {
      description: 'Their comments remain available in the annotations panel.',
      duration: 5000,
    });
  }, []);

  return {
    canRefresh,
    isRefreshing,
    reloadGeneration,
    refresh,
    reportAnnotationRestore,
  };
}
