import { useState, useEffect, useCallback, useRef } from 'react';
import { DEMO_GUIDE, DEMO_GUIDE_ID } from '../../demoGuide';
import type { CodeGuideData } from '@plannotator/shared/guide';

export type { GuideDiffRef, GuideSection, CodeGuideOutput, CodeGuideData } from '@plannotator/shared/guide';

export interface UseGuideDataReturn {
  guide: CodeGuideData | null;
  loading: boolean;
  error: string | null;
  reviewed: boolean[];
  toggleReviewed: (index: number) => void;
  retry: () => void;
}

/** Pad/truncate a persisted reviewed array to the current section count — a
 *  regenerated guide (new jobId) starts fresh, but a stale array shorter or
 *  longer than `sections.length` (server restart, schema drift) shouldn't crash. */
function normalizeReviewed(reviewed: boolean[] | undefined, sectionCount: number): boolean[] {
  const next = new Array(sectionCount).fill(false);
  if (!reviewed) return next;
  for (let i = 0; i < sectionCount; i++) next[i] = !!reviewed[i];
  return next;
}

export function useGuideData(jobId: string): UseGuideDataReturn {
  const [guide, setGuide] = useState<CodeGuideData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reviewed, setReviewed] = useState<boolean[]>([]);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingReviewedRef = useRef<boolean[] | null>(null);
  // Gates the persistence effect below: true = the next `reviewed` change is
  // a SEED (fetch resolved / demo short-circuit), not a user toggle, so skip
  // the PUT. Starts true (initial empty array) and is re-armed at every seed
  // site (see fetchGuide) — it's only ever cleared inside toggleReviewed
  // itself (the real user action), never by the persistence effect. That
  // makes it immune to React StrictMode's dev-only mount→cleanup→remount
  // replay of effects: however many times the persistence effect happens to
  // run for the same seeded state, the flag still reads whatever the last
  // real call site (seed or toggle) wrote, so it can't be "consumed" into a
  // false negative by an extra replay.
  const skipNextSaveRef = useRef(true);
  // Bumped by retry() to re-run the fetch effect without calling fetchGuide
  // directly — a direct call would return a fresh cleanup closure that the
  // caller (a button's onClick) has nowhere to store, so the in-flight
  // request it just superseded would never get its `cancelled` flag set and
  // could still clobber state after a later retry resolves first.
  const [refreshNonce, setRefreshNonce] = useState(0);

  const fetchGuide = useCallback((): (() => void) | void => {
    if (!jobId) return;
    setLoading(true);
    setError(null);

    // Dev short-circuit: render the demo guide without a backend.
    if (jobId === DEMO_GUIDE_ID) {
      skipNextSaveRef.current = true;
      setGuide(DEMO_GUIDE);
      setReviewed(normalizeReviewed(DEMO_GUIDE.reviewed, DEMO_GUIDE.sections.length));
      setLoading(false);
      return;
    }

    // Out-of-order guard: jobId can change (switching to a different completed
    // guide) while a previous fetch is still in flight. Without this, a slow
    // response for an OLDER jobId could resolve AFTER a newer jobId's fetch
    // and clobber its state. The effect below tears this down via the
    // returned cleanup whenever jobId changes (or on unmount).
    let cancelled = false;

    fetch(`/api/guide/${jobId}`)
      .then((res) => {
        if (!res.ok) throw new Error(res.status === 404 ? 'Guide not found' : `HTTP ${res.status}`);
        return res.json();
      })
      .then((data: CodeGuideData) => {
        if (cancelled) return;
        setGuide(data);
        skipNextSaveRef.current = true;
        setReviewed(normalizeReviewed(data.reviewed, data.sections.length));
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [jobId]);

  useEffect(() => {
    return fetchGuide();
    // refreshNonce has no bearing on WHAT is fetched (fetchGuide already
    // captures jobId) — it exists purely to force this effect to re-run on
    // retry(), so the cancellation guard below is owned by the same effect
    // instance for every fetch, manual retries included.
  }, [fetchGuide, refreshNonce]);

  const saveReviewed = useCallback(
    (next: boolean[]) => {
      if (jobId === DEMO_GUIDE_ID) return;
      pendingReviewedRef.current = next;
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      saveTimerRef.current = setTimeout(() => {
        const payload = pendingReviewedRef.current;
        pendingReviewedRef.current = null;
        saveTimerRef.current = null;
        if (!payload) return;
        fetch(`/api/guide/${jobId}/reviewed`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ reviewed: payload }),
        }).catch(() => {});
      }, 500);
    },
    [jobId],
  );

  // Pure functional updater — safe under React StrictMode's dev-only
  // double-invoke of setState updaters (no side effects inside). Persistence
  // is handled by the effect below instead of here.
  const toggleReviewed = useCallback((index: number) => {
    skipNextSaveRef.current = false;
    setReviewed((prev) => {
      const next = [...prev];
      next[index] = !next[index];
      return next;
    });
  }, []);

  // Persists whenever `reviewed` changes, except for the initial seed from
  // fetch/demo (skipNextSaveRef — see its declaration above for why toggling
  // it only from seed/toggle call sites, never from here, is StrictMode-safe).
  // saveReviewed always receives the CURRENT `reviewed` (this effect's
  // closure), so pendingReviewedRef.current — read by the unmount flush below
  // — always reflects the latest change, not a stale one.
  useEffect(() => {
    if (skipNextSaveRef.current) return;
    saveReviewed(reviewed);
  }, [reviewed, saveReviewed]);

  useEffect(() => {
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      const payload = pendingReviewedRef.current;
      pendingReviewedRef.current = null;
      if (!payload || jobId === DEMO_GUIDE_ID) return;
      // keepalive lets the request survive if this unmount is part of a tab close.
      fetch(`/api/guide/${jobId}/reviewed`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reviewed: payload }),
        keepalive: true,
      }).catch(() => {});
    };
  }, [jobId]);

  const retry = useCallback(() => setRefreshNonce((n) => n + 1), []);

  return { guide, loading, error, reviewed, toggleReviewed, retry };
}
