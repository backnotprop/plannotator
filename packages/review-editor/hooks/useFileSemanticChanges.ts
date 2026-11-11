import { useEffect, useState } from 'react';
import type {
  SemanticDiffBinaryChange,
  SemanticDiffChange,
  SemanticDiffResponse,
} from '@plannotator/shared/semantic-diff-types';
import { isOrphanChange } from '../dock/panels/semanticDiffShared';

let cacheKey: string | null = null;
let cachePromise: Promise<SemanticDiffResponse> | null = null;

const RETRY_DELAYS_MS = [5_000, 15_000, 30_000];
const FAILURE_RETRY_COOLDOWN_MS = 60_000;

async function fetchSemanticDiff(): Promise<SemanticDiffResponse> {
  const res = await fetch('/api/semantic-diff');
  if (!res.ok) throw new Error('Semantic diff failed');
  return res.json() as Promise<SemanticDiffResponse>;
}

function loadSemanticDiff(rawPatch: string): Promise<SemanticDiffResponse> {
  if (cacheKey === rawPatch && cachePromise) return cachePromise;
  cacheKey = rawPatch;

  const attempt = async (): Promise<SemanticDiffResponse> => {
    for (let i = 0; ; i++) {
      let result: SemanticDiffResponse;
      try {
        result = await fetchSemanticDiff();
      } catch (error) {
        result = {
          status: 'error',
          reason: 'fetch-failed',
          message: error instanceof Error ? error.message : String(error),
        };
      }
      if (result.status !== 'error' || i >= RETRY_DELAYS_MS.length) return result;
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAYS_MS[i]));
      if (cacheKey !== rawPatch) return result;
    }
  };

  const promise = attempt().then((data) => {
    if (data.status !== 'ok') {
      console.error('Failed to load semantic diff for file badges:', data.message ?? data.reason ?? data.status);
    }
    if (data.status === 'error' && cacheKey === rawPatch && cachePromise === promise) {
      setTimeout(() => {
        if (cacheKey === rawPatch && cachePromise === promise) {
          cacheKey = null;
          cachePromise = null;
        }
      }, FAILURE_RETRY_COOLDOWN_MS);
    }
    return data;
  });
  cachePromise = promise;
  return promise;
}

export interface FileSemanticChanges {
  loading: boolean;
  changes: SemanticDiffChange[];
  binaryChanges: SemanticDiffBinaryChange[];
}

const EMPTY: FileSemanticChanges = { loading: false, changes: [], binaryChanges: [] };

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

const NO_CHANGES: readonly SemanticDiffChange[] = [];

export function useSemanticDiffChanges(rawPatch: string, enabled: boolean): readonly SemanticDiffChange[] {
  const [changes, setChanges] = useState<readonly SemanticDiffChange[]>(NO_CHANGES);
  useEffect(() => {
    if (!enabled) {
      setChanges(NO_CHANGES);
      return;
    }
    let cancelled = false;
    loadSemanticDiff(rawPatch).then((data) => {
      if (cancelled) return;
      setChanges(data.status === 'ok' ? data.changes.filter((change) => !isOrphanChange(change)) : NO_CHANGES);
    });
    return () => {
      cancelled = true;
    };
  }, [rawPatch, enabled]);
  return changes;
}
