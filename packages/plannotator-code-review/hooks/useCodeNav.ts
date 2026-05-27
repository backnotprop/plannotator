import { useState, useCallback, useRef } from 'react';
import type { CodeNavRequest, CodeNavResponse } from '@plannotator/shared/code-nav';
import { useSessionFetch } from '@plannotator/ui/hooks/useSessionFetch';

export type { CodeNavRequest, CodeNavResponse };

export function useCodeNav() {
  const fetch = useSessionFetch();
  const [result, setResult] = useState<CodeNavResponse | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [activeSymbol, setActiveSymbol] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const resolve = useCallback(async (request: CodeNavRequest) => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setActiveSymbol(request.symbol);
    setIsLoading(true);
    setResult(null);

    try {
      const res = await fetch('/api/code-nav/resolve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
        signal: controller.signal,
      });
      if (!res.ok) throw new Error('Failed');
      const data: CodeNavResponse = await res.json();
      setResult(data);
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      setResult(null);
    } finally {
      if (abortRef.current === controller) {
        setIsLoading(false);
      }
    }
  }, []);

  const clear = useCallback(() => {
    abortRef.current?.abort();
    setResult(null);
    setActiveSymbol(null);
    setIsLoading(false);
  }, []);

  return { result, isLoading, activeSymbol, resolve, clear };
}
