import { useCallback } from 'react';
import { toast } from 'sonner';
import {
  useHtmlRefresh as usePublishedHtmlRefresh,
  type HtmlRefreshSnapshot,
} from '@plannotator/ui/hooks/useHtmlRefresh';
import { fetchHtmlDocumentSnapshot, type HtmlVersionDiffFields } from '../sourceDocumentClient';

/** What a refresh hands the app: the bytes plus, for the root document, the
 * version-diff fields the server recomputed against them. */
export interface HtmlRefreshedDocument extends HtmlVersionDiffFields {
  rawHtml: string;
}

interface UseHtmlRefreshOptions {
  enabled: boolean;
  activePath: string | null;
  onSnapshot: (document: HtmlRefreshedDocument) => void;
  /** The ids the remounted viewer could not re-anchor, once per refresh. */
  onUnanchored?: (missingIds: string[]) => void;
}

interface UseHtmlRefreshResult {
  canRefresh: boolean;
  isRefreshing: boolean;
  reloadGeneration: number;
  refresh: () => Promise<void>;
  reportAnnotationRestore: (missingIds: string[]) => void;
}

/**
 * Plannotator's binding of the published `useHtmlRefresh`: the snapshot
 * comes from `/api/doc` through `fetchHtmlDocumentSnapshot` (which, for the
 * session's root document, also carries the recomputed version diff), URL
 * sessions (http(s) paths) cannot refresh, and every outcome toasts.
 */
export function useHtmlRefresh({
  enabled,
  activePath,
  onSnapshot,
  onUnanchored,
}: UseHtmlRefreshOptions): UseHtmlRefreshResult {
  const canRefresh = enabled && !!activePath && !/^https?:\/\//i.test(activePath);

  const fetchSnapshot = useCallback(async (path: string | null): Promise<HtmlRefreshSnapshot<HtmlVersionDiffFields>> => {
    const result = await fetchHtmlDocumentSnapshot(path ?? '');
    if (result.status !== 'ok') return { status: result.status };
    const { rawHtml, diffHtml, previousPlan, versionInfo } = result.snapshot;
    return { status: 'ok', rawHtml, diffHtml, previousPlan, versionInfo };
  }, []);

  const handleSnapshot = useCallback((rawHtml: string, snapshot: HtmlVersionDiffFields) => {
    onSnapshot({
      rawHtml,
      diffHtml: snapshot.diffHtml,
      previousPlan: snapshot.previousPlan,
      versionInfo: snapshot.versionInfo,
    });
  }, [onSnapshot]);

  const handleResult = useCallback((result: 'refreshed' | 'missing' | 'unavailable') => {
    if (result === 'missing') {
      toast.error('HTML file no longer exists', {
        description: 'The current rendered version remains open.',
      });
    } else if (result === 'unavailable') {
      toast.error('Could not refresh HTML', {
        description: 'The current rendered version remains open. Try again in a moment.',
      });
    } else {
      toast.success('Refreshed HTML from disk');
    }
  }, []);

  const handleUnanchored = useCallback((missingIds: string[]) => {
    onUnanchored?.(missingIds);
    if (missingIds.length === 0) return;
    toast(`${missingIds.length} annotation${missingIds.length === 1 ? ' no longer matches' : 's no longer match'} the HTML`, {
      description: 'Their comments remain available in the annotations panel.',
      duration: 5000,
    });
  }, [onUnanchored]);

  return usePublishedHtmlRefresh<HtmlVersionDiffFields>({
    enabled: canRefresh,
    documentKey: activePath,
    fetchSnapshot,
    onSnapshot: handleSnapshot,
    onUnanchored: handleUnanchored,
    onResult: handleResult,
  });
}
