import { useMemo } from 'react';
import type { DiffFile } from '../types';
import type { ReviewState } from '../dock/ReviewStateContext';

/** The text of one side of a reviewed file, for a hover source preview. */
export interface ReviewFileSource {
  contents: string;
  filepath: string;
}

/** Which side of the diff: `old` for something the change removed, `new` otherwise. */
export type ReviewFileSide = 'old' | 'new';

export type ReviewFileSourceLoader = (filePath: string, side: ReviewFileSide) => Promise<ReviewFileSource | null>;

export interface ReviewFileSourceOptions {
  readonly files: readonly Pick<DiffFile, 'path' | 'oldPath'>[];
  readonly reviewBase?: string;
  readonly snapshotId?: string;
  readonly fetchImpl?: typeof fetch;
}

/**
 * Build the loader behind code review's hover source previews (Call Flow
 * locations, Semantic Changes rows). It reads the file the review shows
 * through `/api/file-content` (both sides, bound to the review's base and
 * snapshot, so a PR or since-base review previews the reviewed source, not
 * the working tree). A path is matched against the diff's files by its new
 * or old name, so a renamed file is asked for with its `oldPath`. One request
 * per file, shared by every caller; a failed request (a stale snapshot, a file
 * the server cannot read) resolves null and is forgotten, so a later hover
 * asks again.
 */
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

/**
 * The hover source loader for the current review, or undefined when the
 * review has no full file contents (a static patch: `/api/file-content`
 * answers 400) so nothing offers a preview.
 */
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
