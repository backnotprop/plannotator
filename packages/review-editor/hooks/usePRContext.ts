import { useState, useRef, useCallback, useEffect } from 'react';
import type { PRContext } from '@plannotator/shared/pr-provider';
import type { PRMetadata } from '@plannotator/shared/pr-provider';

export function usePRContext(prMetadata: PRMetadata | null) {
  const [prContext, setPRContext] = useState<PRContext | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fetched = useRef(false);
  const lastUrl = useRef<string | undefined>(undefined);

  useEffect(() => {
    const url = prMetadata?.url;
    if (url !== lastUrl.current) {
      lastUrl.current = url;
      fetched.current = false;
      setPRContext(null);
      setIsLoading(false);
      setError(null);
    }
  }, [prMetadata?.url]);

  const fetchContext = useCallback(async () => {
    if (!prMetadata || fetched.current) return;
    const requestUrl = prMetadata.url;
    fetched.current = true;
    setIsLoading(true);
    setError(null);

    try {
      const res = await fetch('/api/pr-context');
      if (requestUrl !== lastUrl.current) return;
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      const context: PRContext = await res.json();
      if (requestUrl !== lastUrl.current) return;
      setPRContext(context);
    } catch (err) {
      if (requestUrl !== lastUrl.current) return;
      const message = err instanceof Error ? err.message : 'Failed to load PR context';
      setError(message);
      fetched.current = false;
    } finally {
      if (requestUrl === lastUrl.current) setIsLoading(false);
    }
  }, [prMetadata]);

  return { prContext, isLoading, error, fetchContext };
}
