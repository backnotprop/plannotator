import { useEffect, useState } from 'react';

export interface ReviewFileContents {
  forPath: string;
  old: string | null;
  new: string | null;
}

export interface UseFileContentsOptions {
  filePath: string;
  oldPath?: string;
  reviewBase?: string;
  reviewSnapshotId?: string;
  enabled: boolean;
}

export interface UseFileContentsResult {
  fileContents: ReviewFileContents | null;
  loading: boolean;
  stale: boolean;
}

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
    if (!enabled) return;
    const params = new URLSearchParams({ path: filePath });
    if (oldPath) params.set('oldPath', oldPath);
    if (reviewBase) params.set('base', reviewBase);
    if (reviewSnapshotId) params.set('snapshot', reviewSnapshotId);
    fetch(`/api/file-content?${params}`, { signal: controller.signal })
      .then(res => {
        if (res.status === 409 && !controller.signal.aborted) setStale(true);
        return res.ok ? res.json() : null;
      })
      .then((data: { oldContent: string | null; newContent: string | null } | null) => {
        if (data && (data.oldContent != null || data.newContent != null)) {
          setFileContents({ forPath: filePath, old: data.oldContent, new: data.newContent });
        }
      })
      .catch(() => {})
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [filePath, oldPath, reviewBase, reviewSnapshotId, enabled]);

  return { fileContents, loading, stale };
}
