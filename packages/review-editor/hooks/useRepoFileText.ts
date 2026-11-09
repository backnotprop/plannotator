import { useEffect, useState } from 'react';
import type { RepoFileNoContentReason, RepoFileResponse, RepoRevisionInfo } from '@plannotator/shared/repo-files';

/**
 * One file of the repository at the diff's new side, as text, from
 * `GET /api/repo-file` (approved design record "review-explorer", step 2): a
 * file the review does not change, or the Whole file view of one it does.
 * Read once per path and snapshot; a new snapshot reads again.
 */
export type RepoFileText =
  | { status: 'loading' }
  | { status: 'ready'; content: string; revision: RepoRevisionInfo }
  | { status: 'empty'; reason: RepoFileNoContentReason; size?: number; revision?: RepoRevisionInfo }
  | { status: 'error'; message: string };

const cache = new Map<string, RepoFileText>();
const CACHE_LIMIT = 40;

function remember(key: string, value: RepoFileText) {
  cache.delete(key);
  cache.set(key, value);
  while (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!);
}

export function useRepoFileText(
  path: string | null,
  snapshotId: string | undefined,
  fetchImpl: typeof fetch = fetch,
): RepoFileText {
  const key = path && snapshotId ? `${snapshotId}\0${path}` : null;
  const [state, setState] = useState<RepoFileText>(() => (key && cache.get(key)) || { status: 'loading' });

  useEffect(() => {
    if (!key || !path || !snapshotId) return;
    const cached = cache.get(key);
    if (cached) {
      setState(cached);
      return;
    }
    setState({ status: 'loading' });
    const controller = new AbortController();
    fetchImpl(`/api/repo-file?snapshot=${encodeURIComponent(snapshotId)}&path=${encodeURIComponent(path)}`, { signal: controller.signal })
      .then(async (response) => {
        const body = (await response.json()) as RepoFileResponse & { error?: string; reason?: string };
        let next: RepoFileText;
        if (!response.ok) {
          next = {
            status: 'error',
            message: response.status === 409
              ? 'The diff changed since this tab opened. Refresh to read the file again.'
              : body.error ?? `HTTP ${response.status}`,
          };
        } else if (body.content !== null && body.content !== undefined) {
          next = { status: 'ready', content: body.content, revision: body.revision };
          remember(key, next);
        } else {
          next = { status: 'empty', reason: body.reason ?? 'unavailable', size: body.size, revision: body.revision };
          remember(key, next);
        }
        if (!controller.signal.aborted) setState(next);
      })
      .catch((error) => {
        if (controller.signal.aborted) return;
        setState({ status: 'error', message: error instanceof Error ? error.message : 'The file could not be read.' });
      });
    return () => controller.abort();
  }, [key, path, snapshotId, fetchImpl]);

  return key ? state : { status: 'loading' };
}

/** What a tab says when a file has no text to show. */
export function repoFileEmptyMessage(reason: RepoFileNoContentReason, size?: number): string {
  switch (reason) {
    case 'too-large':
      return size ? `Too large to show (${(size / 1024 / 1024).toFixed(1)} MB; the limit is 5 MB).` : 'Too large to show (the limit is 5 MB).';
    case 'binary':
      return 'A binary file: nothing to show as text.';
    case 'missing':
      return 'This file is not there any more (or is a link).';
    default:
      return 'The platform did not return this file (files over 1 MB are not served without the local checkout).';
  }
}

/** Tests only. */
export function __clearRepoFileTextCache() {
  cache.clear();
}
