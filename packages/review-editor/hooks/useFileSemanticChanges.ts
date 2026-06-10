import { useEffect, useState } from 'react';
import type {
  SemanticDiffBinaryChange,
  SemanticDiffChange,
  SemanticDiffResponse,
} from '@plannotator/shared/semantic-diff-types';
import { isOrphanChange } from '../dock/panels/semanticDiffShared';

/**
 * Single shared fetch of the semantic diff, cached by the active patch so every
 * file-header badge reuses one request (sem already caches per-patch server-side).
 */
let cacheKey: string | null = null;
let cachePromise: Promise<SemanticDiffResponse> | null = null;

function loadSemanticDiff(rawPatch: string): Promise<SemanticDiffResponse> {
  if (cacheKey === rawPatch && cachePromise) return cachePromise;
  cacheKey = rawPatch;
  cachePromise = fetch('/api/semantic-diff')
    .then((res) => {
      if (!res.ok) throw new Error('Semantic diff failed');
      return res.json() as Promise<SemanticDiffResponse>;
    })
    .catch((error): SemanticDiffResponse => ({
      status: 'error',
      reason: 'fetch-failed',
      message: error instanceof Error ? error.message : String(error),
    }))
    .then((data) => {
      // Logged once per patch (the promise is cached) rather than per badge, so a
      // systemic failure leaves a trace instead of every badge vanishing silently.
      if (data.status !== 'ok') {
        console.error('Failed to load semantic diff for file badges:', data.message ?? data.reason ?? data.status);
      }
      return data;
    });
  return cachePromise;
}

export interface FileSemanticChanges {
  loading: boolean;
  changes: SemanticDiffChange[];
  binaryChanges: SemanticDiffBinaryChange[];
}

const EMPTY: FileSemanticChanges = { loading: false, changes: [], binaryChanges: [] };

/** Named (non-orphan) semantic changes for a single file, or empty when disabled/unavailable. */
export function useFileSemanticChanges(
  filePath: string,
  rawPatch: string,
  enabled: boolean,
): FileSemanticChanges {
  const [state, setState] = useState<FileSemanticChanges>(enabled ? { ...EMPTY, loading: true } : EMPTY);

  useEffect(() => {
    if (!enabled) {
      setState(EMPTY);
      return;
    }

    let cancelled = false;
    setState((prev) => (prev.loading ? prev : { ...prev, loading: true }));

    loadSemanticDiff(rawPatch).then((data) => {
      if (cancelled) return;
      if (data.status !== 'ok') {
        setState(EMPTY);
        return;
      }
      setState({
        loading: false,
        changes: data.changes.filter((c) => c.filePath === filePath && !isOrphanChange(c)),
        binaryChanges: data.binaryChanges.filter((c) => c.filePath === filePath),
      });
    });

    return () => {
      cancelled = true;
    };
  }, [filePath, rawPatch, enabled]);

  return state;
}
