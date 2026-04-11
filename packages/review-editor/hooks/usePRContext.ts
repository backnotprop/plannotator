import { useState, useRef, useCallback, useEffect } from 'react';
import type { PRContext } from '@plannotator/shared/pr-provider';
import type { PRMetadata } from '@plannotator/shared/pr-provider';

export function usePRContext(prMetadata: PRMetadata | null, repoId?: string | null) {
  const [prContext, setPRContext] = useState<PRContext | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fetched = useRef(false);

  useEffect(() => {
    fetched.current = false;
    setPRContext(null);
    setError(null);
  }, [prMetadata, repoId]);

  const fetchContext = useCallback(async () => {
    if (!prMetadata || fetched.current) return;
    fetched.current = true;
    setIsLoading(true);
    setError(null);

    try {
      const suffix = repoId ? `?repoId=${encodeURIComponent(repoId)}` : '';
      const res = await fetch(`/api/pr-context${suffix}`);
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      const context: PRContext = await res.json();
      setPRContext(context);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to load PR context';
      setError(message);
      fetched.current = false;
    } finally {
      setIsLoading(false);
    }
  }, [prMetadata, repoId]);

  return { prContext, isLoading, error, fetchContext };
}
