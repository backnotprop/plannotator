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
  const skipNextSaveRef = useRef(true);

  const [refreshNonce, setRefreshNonce] = useState(0);

  const fetchTour = useCallback((): (() => void) | void => {
    if (!jobId) return;
    setLoading(true);
    setError(null);

    if (jobId === DEMO_TOUR_ID) {
      skipNextSaveRef.current = true;
      setTour(DEMO_TOUR);
      setChecked(new Array(DEMO_TOUR.qa_checklist.length).fill(false));
      setLoading(false);
      return;
    }

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

  const toggleChecked = useCallback((index: number) => {
    skipNextSaveRef.current = false;
    setChecked((prev) => {
      const next = [...prev];
      next[index] = !next[index];
      return next;
    });
  }, []);

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
