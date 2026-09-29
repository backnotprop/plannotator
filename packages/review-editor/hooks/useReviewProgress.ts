import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { toast } from 'sonner';

interface ProgressData {
  available: boolean;
  key: string;
  fingerprints: Record<string, string>;
  viewedFiles: string[];
  suppressedFiles: string[];
}

type ProgressStatus = 'loading' | 'ready' | 'unsupported' | 'error';

const PROGRESS_TIMEOUT_MS = 5000;

/** Persist explicit mutations, never hydrated state. Requests are serialized so
 * a quick check/uncheck cannot arrive in reverse order. Each captures its own
 * snapshot; neither late loads nor late writes may affect a different review.
 */
export function useReviewProgress({
  snapshotId, contextKey, enabled, setViewedFiles, setSuppressedFiles,
}: {
  snapshotId?: string;
  contextKey: string;
  enabled: boolean;
  setViewedFiles: (files: Set<string>) => void;
  setSuppressedFiles: Dispatch<SetStateAction<Set<string>>>;
}) {
  const snapshot = useMemo(() => ({
    id: enabled ? snapshotId : undefined,
    data: null as ProgressData | null,
    edits: new Map<string, boolean>(),
    pending: new Map<string, { viewed: boolean }>(),
    loading: Promise.resolve(),
    loadVersion: 0,
    status: (enabled && snapshotId ? 'loading' : 'unsupported') as ProgressStatus,
  }), [snapshotId, contextKey, enabled]);
  const active = useRef(snapshot);
  active.current = snapshot;
  const writes = useRef(Promise.resolve());
  const [loaded, setLoaded] = useState<{ snapshot: typeof snapshot; status: ProgressStatus } | null>(null);
  const loadedContext = useRef(contextKey);
  const warned = useRef(false);
  const warn = useCallback(() => {
    if (warned.current) return;
    warned.current = true;
    toast.error('Could not save or restore viewed-file progress');
  }, []);

  const save = useCallback((target: typeof snapshot, pending: typeof snapshot.pending) => {
    const data = target.data;
    if (!target.id || !data?.available) return;
    const edits = new Map(pending);
    const changes = [...edits].flatMap(([path, { viewed }]) =>
      Object.hasOwn(data.fingerprints, path) ? [{ path, viewed, fingerprint: data.fingerprints[path] }] : []);
    if (!changes.length) return;
    const url = `/api/review-progress?snapshot=${encodeURIComponent(target.id)}`;
    const body = JSON.stringify({ key: data.key, changes });
    writes.current = writes.current.then(async () => {
      const response = await fetch(url, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body, keepalive: true,
        signal: AbortSignal.timeout(PROGRESS_TIMEOUT_MS),
      });
      if (!response.ok) throw new Error('Progress save failed');
      for (const { path } of changes) {
        if (target.pending.get(path) === edits.get(path)) target.pending.delete(path);
      }
    }).catch(warn);
  }, [warn]);

  const load = useCallback((target: typeof snapshot) => {
    if (!target.id) return;
    const version = ++target.loadVersion;
    target.status = 'loading';
    setLoaded({ snapshot: target, status: 'loading' });
    // Keep current state until a successful load. Failed/unsupported endpoints
    // retain the draft fallback, and a later mutation or flush retries errors.
    target.loading = fetch(`/api/review-progress?snapshot=${encodeURIComponent(target.id)}`, {
      signal: AbortSignal.timeout(PROGRESS_TIMEOUT_MS),
    })
      .then(async response => {
        if (response.status === 404) return { available: false } as ProgressData;
        if (!response.ok) throw new Error('Progress load failed');
        return await response.json() as ProgressData;
      })
      .then(data => {
        if (active.current !== target || target.loadVersion !== version) return;
        target.data = data;
        target.status = data.available ? 'ready' : 'unsupported';
        setLoaded({ snapshot: target, status: target.status });
        if (!data.available) return;
        const viewed = new Set(data.viewedFiles);
        for (const [path, checked] of target.edits) {
          if (checked) viewed.add(path);
          else viewed.delete(path);
        }
        setViewedFiles(viewed);
        const sameContext = loadedContext.current === contextKey;
        loadedContext.current = contextKey;
        setSuppressedFiles(previous => {
          // An explicit "come back to this" survives an in-session refresh,
          // even when changed content invalidates the durable viewed mark.
          const suppressed = new Set(sameContext ? [...previous, ...data.suppressedFiles] : data.suppressedFiles);
          for (const [path, checked] of target.edits) {
            if (checked) suppressed.delete(path);
            else suppressed.add(path);
          }
          return suppressed;
        });
        save(target, target.pending);
      })
      .catch(() => {
        if (active.current !== target || target.loadVersion !== version) return;
        target.status = 'error';
        setLoaded({ snapshot: target, status: 'error' });
        warn();
      });
  }, [contextKey, setViewedFiles, setSuppressedFiles, save, warn]);

  useEffect(() => {
    load(snapshot);
    return () => { snapshot.loadVersion++; };
  }, [snapshot, load]);

  const persistViewed = useCallback((paths: string[], viewed: boolean) => {
    const target = active.current;
    const edits = new Map(paths.map(path => [path, { viewed }]));
    for (const [path, edit] of edits) {
      target.edits.set(path, viewed);
      target.pending.set(path, edit);
    }
    if (target.status === 'error') load(target);
    else save(target, edits);
  }, [save, load]);

  const flush = useCallback(async () => {
    const target = active.current;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let expired = false;
    try {
      await Promise.race([
        (async () => {
          if (target.status === 'error') load(target);
          await target.loading;
          await writes.current;
          // A failed POST keeps its pending edits for one retry within this
          // flush's budget. Existing writes remain ordered and snapshot-bound.
          if (!expired) save(target, target.pending);
          await writes.current;
        })(),
        new Promise<void>(resolve => {
          // Bound the entire queue, not just each request: several stalled
          // writes must not hold up switching, submitting or closing a review.
          timer = setTimeout(() => {
            expired = true;
            warn();
            resolve();
          }, PROGRESS_TIMEOUT_MS);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }, [load, save, warn]);

  return {
    status: loaded?.snapshot === snapshot ? loaded.status : snapshot.status,
    persistViewed,
    flush,
  };
}
