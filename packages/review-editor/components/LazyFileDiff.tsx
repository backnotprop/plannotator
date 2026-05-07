import React, { useState, useEffect, useRef, useMemo } from 'react';
import { FileDiff, type DiffLineAnnotation } from '@pierre/diffs/react';
import type { FileDiffMetadata } from '@pierre/diffs';
import { processFile } from '@pierre/diffs';
import type { DiffAnnotationMetadata, SelectedLineRange } from '@plannotator/ui/types';
import type { DiffFile } from '../types';

interface LazyFileDiffProps {
  file: DiffFile;
  baseDiff: FileDiffMetadata;
  forceMount?: boolean;
  scrollRoot: HTMLElement | null;
  reviewBase?: string;
  diffStyle: 'split' | 'unified';
  options: Record<string, unknown>;
  annotations: DiffLineAnnotation<DiffAnnotationMetadata>[];
  selectedLines: SelectedLineRange | undefined;
  renderAnnotation: (annotation: DiffLineAnnotation<DiffAnnotationMetadata>) => React.ReactNode;
}

function estimateHeight(fileDiff: FileDiffMetadata, diffStyle: 'split' | 'unified'): number {
  const lineCount = diffStyle === 'split' ? fileDiff.splitLineCount : fileDiff.unifiedLineCount;
  return (lineCount * 20) + (fileDiff.hunks.length * 32) + 8;
}

export const LazyFileDiff: React.FC<LazyFileDiffProps> = ({
  file,
  baseDiff,
  forceMount = false,
  scrollRoot,
  reviewBase,
  diffStyle,
  options,
  annotations,
  selectedLines,
  renderAnnotation,
}) => {
  const [mounted, setMounted] = useState(forceMount);
  const sentinelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (forceMount && !mounted) setMounted(true);
  }, [forceMount, mounted]);

  useEffect(() => {
    if (mounted) return;
    const el = sentinelRef.current;
    if (!el || !scrollRoot) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setMounted(true);
          observer.disconnect();
        }
      },
      { root: scrollRoot, rootMargin: '100% 0px 100% 0px', threshold: 0 },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [mounted, scrollRoot]);

  // Per-file content fetching (same pattern as DiffViewer.tsx)
  const [fileContents, setFileContents] = useState<{ old: string | null; new: string | null } | null>(null);
  useEffect(() => {
    if (!mounted) return;
    setFileContents(null);
    const controller = new AbortController();
    const params = new URLSearchParams({ path: file.path });
    if (file.oldPath) params.set('oldPath', file.oldPath);
    if (reviewBase) params.set('base', reviewBase);
    fetch(`/api/file-content?${params}`, { signal: controller.signal })
      .then(res => res.ok ? res.json() : null)
      .then((data: { oldContent: string | null; newContent: string | null } | null) => {
        if (data && (data.oldContent != null || data.newContent != null)) {
          setFileContents({ old: data.oldContent, new: data.newContent });
        }
      })
      .catch(() => {});
    return () => controller.abort();
  }, [mounted, file.path, file.oldPath, file.patch, reviewBase]);

  const fileDiff = useMemo(() => {
    if (!fileContents) return baseDiff;
    try {
      const result = processFile(file.patch, {
        oldFile: fileContents.old != null ? { name: file.oldPath || file.path, contents: fileContents.old } : undefined,
        newFile: fileContents.new != null ? { name: file.path, contents: fileContents.new } : undefined,
      });
      return result || baseDiff;
    } catch {
      return baseDiff;
    }
  }, [file.patch, file.path, file.oldPath, fileContents, baseDiff]);

  if (!mounted) {
    return (
      <div
        ref={sentinelRef}
        style={{ height: estimateHeight(baseDiff, diffStyle) }}
        className="pb-2"
      />
    );
  }

  return (
    <div className="pb-2">
      <FileDiff
        key={file.path}
        fileDiff={fileDiff}
        options={options}
        lineAnnotations={annotations}
        selectedLines={selectedLines}
        renderAnnotation={renderAnnotation}
      />
    </div>
  );
};
