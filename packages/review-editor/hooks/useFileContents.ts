import { useEffect, useState } from 'react';
import { loadReviewFileContents } from '../utils/loadReviewFileContents';

/** Both sides of one file as the server read them for the current diff. */
export interface ReviewFileContents {
  /** The file these contents belong to; a consumer ignores them for any other path. */
  forPath: string;
  old: string | null;
  new: string | null;
}

export interface UseFileContentsOptions {
  filePath: string;
  oldPath?: string;
  /** Base branch override (branch / merge-base modes). */
  reviewBase?: string;
  /** Opaque diff snapshot; the server rejects a lookup from another view. */
  reviewSnapshotId?: string;
  /** False when there is no source behind the diff (static patch review):
   *  nothing is fetched and `loading` is false. */
  enabled: boolean;
}

export interface UseFileContentsResult {
  fileContents: ReviewFileContents | null;
  /** True from the start of a fetch until it settles. */
  loading: boolean;
  /** The server refused the lookup because the diff snapshot it was asked
   *  about is no longer the one it serves (409): refresh the diff. */
  stale: boolean;
}

/**
 * Fetch both sides of a file through `/api/file-content` for the active diff.
 * Refetches when the file, base or snapshot changes and aborts the previous
 * request. A failure (or a server without the file) leaves `fileContents`
 * null: callers fall back to the patch alone.
 */
export function useFileContents({
  filePath,
  oldPath,
  reviewBase,
  reviewSnapshotId,
  enabled,
}: UseFileContentsOptions): UseFileContentsResult {
  const [fileContents, setFileContents] = useState<ReviewFileContents | null>(null);
  const [loading, setLoading] = useState(enabled);
  const [stale, setStale] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    setFileContents(null);
    setLoading(enabled);
    setStale(false);
    // Nothing to expand into: the patch is the whole content of the session.
    if (!enabled) return;
    loadReviewFileContents(filePath, oldPath, reviewBase, reviewSnapshotId, controller.signal)
      .then(({ status, contents: data }) => {
        if (controller.signal.aborted) return;
        if (status === 409) setStale(true);
        if (data && (data.oldContent != null || data.newContent != null)) {
          setFileContents({ forPath: filePath, old: data.oldContent, new: data.newContent });
        }
      })
      .catch(() => {}) // Silent fallback — no expansion in demo mode
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [filePath, oldPath, reviewBase, reviewSnapshotId, enabled]);

  return { fileContents, loading, stale };
}
