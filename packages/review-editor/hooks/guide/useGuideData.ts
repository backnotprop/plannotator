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
  const skipNextSaveRef = useRef(true);
  const [refreshNonce, setRefreshNonce] = useState(0);

  const fetchGuide = useCallback((): (() => void) | void => {
    if (!jobId) return;
    setLoading(true);
    setError(null);

    if (jobId === DEMO_GUIDE_ID) {
      skipNextSaveRef.current = true;
      setGuide(DEMO_GUIDE);
      setReviewed(normalizeReviewed(DEMO_GUIDE.reviewed, DEMO_GUIDE.sections.length));
      setLoading(false);
      return;
    }

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

  const toggleReviewed = useCallback((index: number) => {
    skipNextSaveRef.current = false;
    setReviewed((prev) => {
      const next = [...prev];
      next[index] = !next[index];
      return next;
    });
  }, []);

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
