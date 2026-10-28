import { useState, useCallback, useRef } from 'react';

const MAX_CACHE_ENTRIES = 10;

export interface PreviewData {
  lines: string[];
  startLine: number;
  targetLine: number;
  filePath: string;
}

export function useCodeNavPreview() {
  const [previewData, setPreviewData] = useState<PreviewData | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const cacheRef = useRef(new Map<string, string>());
  const abortRef = useRef<AbortController | null>(null);

  const selectLocation = useCallback(
    async (filePath: string, line: number) => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      const cache = cacheRef.current;
      const cached = cache.get(filePath);

      if (cached) {
        setIsLoading(false);
        const allLines = cached.split('\n');
        setPreviewData({
          lines: allLines,
          startLine: 1,
          targetLine: line,
          filePath,
        });
        return;
      }

      setIsLoading(true);
      try {
        const res = await fetch(
          `/api/code-nav/file?path=${encodeURIComponent(filePath)}`,
          { signal: controller.signal },
        );
        if (!res.ok) throw new Error('Failed');
        const data: { content: string } = await res.json();

        if (cache.size >= MAX_CACHE_ENTRIES) {
          const firstKey = cache.keys().next().value;
          if (firstKey) cache.delete(firstKey);
        }
        cache.set(filePath, data.content);

        if (controller.signal.aborted) return;

        const allLines = data.content.split('\n');
        setPreviewData({
          lines: allLines,
          startLine: 1,
          targetLine: line,
          filePath,
        });
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        setPreviewData(null);
      } finally {
        if (abortRef.current === controller) {
          setIsLoading(false);
        }
      }
    },
    [],
  );

  const clear = useCallback(() => {
    abortRef.current?.abort();
    setPreviewData(null);
    setIsLoading(false);
  }, []);

  return { previewData, isLoading, selectLocation, clear };
}
