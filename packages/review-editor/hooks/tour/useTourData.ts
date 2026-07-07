import { useState, useEffect, useCallback, useRef } from 'react';
import { DEMO_TOUR, DEMO_TOUR_ID } from '../../demoTour';
import type { CodeTourData } from '@plannotator/shared/tour';

export type { TourDiffAnchor, TourKeyTakeaway, TourStop, TourQAItem, CodeTourData } from '@plannotator/shared/tour';

export interface UseTourDataReturn {
  tour: CodeTourData | null;
  loading: boolean;
  error: string | null;
  checked: boolean[];
  toggleChecked: (index: number) => void;
  retry: () => void;
}

export function useTourData(jobId: string): UseTourDataReturn {
  const [tour, setTour] = useState<CodeTourData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [checked, setChecked] = useState<boolean[]>([]);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingChecklistRef = useRef<boolean[] | null>(null);
  // Gates the persistence effect below: true = the next `checked` change is a
  // SEED (fetch resolved / demo short-circuit), not a user toggle, so skip
  // the PUT. Starts true (initial empty array) and is re-armed at every seed
  // site (see fetchTour) — it's only ever cleared inside toggleChecked itself
  // (the real user action), never by the persistence effect. That makes it
  // immune to React StrictMode's dev-only mount→cleanup→remount replay of
  // effects: however many times the persistence effect happens to run for the
  // same seeded state, the flag still reads whatever the last real call site
  // (seed or toggle) wrote, so it can't be "consumed" into a false negative by
  // an extra replay.
  const skipNextSaveRef = useRef(true);

  // Bumped by retry() to re-run the fetch effect below rather than calling
  // fetchTour directly — a direct call returns a fresh cleanup closure that
  // the caller (a button's onClick) has nowhere to store, so the request it
  // superseded would never get its `cancelled` flag set and could still
  // clobber state after a later retry resolves first. Mirrors useGuideData.
  const [refreshNonce, setRefreshNonce] = useState(0);

  const fetchTour = useCallback((): (() => void) | void => {
    if (!jobId) return;
    setLoading(true);
    setError(null);

    // Dev short-circuit: render the demo tour without a backend.
    if (jobId === DEMO_TOUR_ID) {
      skipNextSaveRef.current = true;
      setTour(DEMO_TOUR);
      setChecked(new Array(DEMO_TOUR.qa_checklist.length).fill(false));
      setLoading(false);
      return;
    }

    // Out-of-order guard: jobId can change (switching to a different completed
    // tour) while a previous fetch is still in flight. Without this, a slow
    // response for an OLDER jobId could resolve AFTER a newer jobId's fetch
    // and clobber its state. The effect below tears this down via the
    // returned cleanup whenever jobId changes (or on unmount).
    let cancelled = false;

    fetch(`/api/tour/${jobId}`)
      .then((res) => {
        if (!res.ok) throw new Error(res.status === 404 ? 'Tour not found' : `HTTP ${res.status}`);
        return res.json();
      })
      .then((data: CodeTourData) => {
        if (cancelled) return;
        setTour(data);
        skipNextSaveRef.current = true;
        setChecked(data.checklist?.length > 0 ? data.checklist : new Array(data.qa_checklist.length).fill(false));
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
    return fetchTour();
    // refreshNonce has no bearing on WHAT is fetched (fetchTour already
    // captures jobId) — it exists purely to force this effect to re-run on
    // retry(), so the cancellation guard is owned by the same effect
    // instance for every fetch, manual retries included.
  }, [fetchTour, refreshNonce]);

  const saveChecklist = useCallback(
    (next: boolean[]) => {
      if (jobId === DEMO_TOUR_ID) return;
      pendingChecklistRef.current = next;
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      saveTimerRef.current = setTimeout(() => {
        const payload = pendingChecklistRef.current;
        pendingChecklistRef.current = null;
        saveTimerRef.current = null;
        if (!payload) return;
        fetch(`/api/tour/${jobId}/checklist`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ checked: payload }),
        }).catch(() => {});
      }, 500);
    },
    [jobId],
  );

  // Pure functional updater — safe under React StrictMode's dev-only
  // double-invoke of setState updaters (no side effects inside). Persistence
  // is handled by the effect below instead of here.
  const toggleChecked = useCallback((index: number) => {
    skipNextSaveRef.current = false;
    setChecked((prev) => {
      const next = [...prev];
      next[index] = !next[index];
      return next;
    });
  }, []);

  // Persists whenever `checked` changes, except for the initial seed from
  // fetch/demo (skipNextSaveRef — see its declaration above for why toggling
  // it only from seed/toggle call sites, never from here, is StrictMode-safe).
  // saveChecklist always receives the CURRENT `checked` (this effect's
  // closure), so pendingChecklistRef.current — read by the unmount flush
  // below — always reflects the latest change, not a stale one.
  useEffect(() => {
    if (skipNextSaveRef.current) return;
    saveChecklist(checked);
  }, [checked, saveChecklist]);

  useEffect(() => {
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      const payload = pendingChecklistRef.current;
      pendingChecklistRef.current = null;
      if (!payload || jobId === DEMO_TOUR_ID) return;
      // keepalive lets the request survive if this unmount is part of a tab close.
      fetch(`/api/tour/${jobId}/checklist`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ checked: payload }),
        keepalive: true,
      }).catch(() => {});
    };
  }, [jobId]);

  const retry = useCallback(() => setRefreshNonce((n) => n + 1), []);

  return { tour, loading, error, checked, toggleChecked, retry };
}
