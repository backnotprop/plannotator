import { useMemo } from 'react';
import type { DiffFile } from '../types';
import type { ReviewState } from '../dock/ReviewStateContext';

export interface ReviewFileSource {
  contents: string;
  filepath: string;
}

export type ReviewFileSide = 'old' | 'new';

export type ReviewFileSourceLoader = (filePath: string, side: ReviewFileSide) => Promise<ReviewFileSource | null>;

export interface ReviewFileSourceOptions {
  readonly files: readonly Pick<DiffFile, 'path' | 'oldPath'>[];
  readonly reviewBase?: string;
  readonly snapshotId?: string;
  readonly fetchImpl?: typeof fetch;
}

export function createReviewFileSourceLoader({
  files,
  reviewBase,
  snapshotId,
  fetchImpl = fetch,
}: ReviewFileSourceOptions): ReviewFileSourceLoader {
  const cache = new Map<string, Promise<{ oldContent: string | null; newContent: string | null } | null>>();
  return async (filePath, side) => {
    const diffFile = files.find((file) => file.path === filePath || file.oldPath === filePath);
    const path = diffFile?.path ?? filePath;
    const oldPath = diffFile?.oldPath;
    const key = `${path}\0${oldPath ?? ''}`;
    let request = cache.get(key);
    if (!request) {
      const params = new URLSearchParams({ path });
      if (oldPath) params.set('oldPath', oldPath);
      if (reviewBase) params.set('base', reviewBase);
      if (snapshotId) params.set('snapshot', snapshotId);
      request = fetchImpl(`/api/file-content?${params}`)
        .then((res) => (res.ok ? res.json() : null))
        .catch(() => null);
      cache.set(key, request);
      void request.then((data) => { if (!data) cache.delete(key); });
    }
    const data = await request;
    const contents = side === 'old' ? data?.oldContent : data?.newContent;
    return contents != null ? { contents, filepath: filePath } : null;
  };
}

export function useReviewFileSource(state: ReviewState | null): ReviewFileSourceLoader | undefined {
  const files = state?.files;
  const reviewBase = state?.reviewBase;
  const snapshotId = state?.feedbackDiffContext?.snapshotId;
  const available = Boolean(state) && state?.contextExpansionAvailable !== false;
  return useMemo(
    () => (available && files ? createReviewFileSourceLoader({ files, reviewBase, snapshotId }) : undefined),
    [available, files, reviewBase, snapshotId],
  );
}
