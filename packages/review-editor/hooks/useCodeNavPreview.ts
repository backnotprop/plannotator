import { useState, useCallback, useRef } from 'react';

const MAX_CACHE_ENTRIES = 10;

export interface PreviewData {
  lines: string[];
  startLine: number;
  targetLine: number;
  filePath: string;
}

/** Error body of GET /api/code-nav/file (packages/shared/repo-file.ts). */
interface CodeNavFileError {
  error?: string;
  reason?: string;
  size?: number;
  maxBytes?: number;
}

function formatMegabytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1).replace(/\.0$/, '')} MB`;
}

/** The plain sentence the preview shows when the server refuses a file. */
export function codeNavPreviewErrorMessage(body: CodeNavFileError | null): string {
  switch (body?.reason) {
    case 'too-large': {
      if (body.size == null || body.maxBytes == null) return 'This file is too large to preview.';
      const size = formatMegabytes(body.size);
      const limit = formatMegabytes(body.maxBytes);
      // A file just over the limit rounds to the limit itself ("5 MB; the
      // limit is 5 MB"), so say "just over" instead of two equal numbers.
      return size === limit
        ? `This file is too large to preview (just over the ${limit} limit).`
        : `This file is too large to preview (${size}; the limit is ${limit}).`;
    }
    case 'not-a-file':
      return 'This path is not a regular file, so it cannot be previewed.';
    case 'not-found':
      return 'This file was not found.';
    default:
      return 'This file could not be previewed.';
  }
}

export function useCodeNavPreview() {
  const [previewData, setPreviewData] = useState<PreviewData | null>(null);
  const [error, setError] = useState<string | null>(null);
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

      setError(null);
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
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as CodeNavFileError | null;
          if (controller.signal.aborted) return;
          setPreviewData(null);
          setError(codeNavPreviewErrorMessage(body));
          return;
        }
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
        setError(codeNavPreviewErrorMessage(null));
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
    setError(null);
    setIsLoading(false);
  }, []);

  return { previewData, error, isLoading, selectLocation, clear };
}
