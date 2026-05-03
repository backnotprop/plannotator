import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { FileDiff, type DiffLineAnnotation } from '@pierre/diffs/react';
import type { FileDiffMetadata, SelectedLineRange as PierreSelectedLineRange } from '@pierre/diffs';
import { processFile } from '@pierre/diffs';
import type { DiffAnnotationMetadata, SelectedLineRange } from '@plannotator/ui/types';
import type { DiffFile } from '../types';
import { getChangedLineNumbersFromPatch } from '../utils/patchParser';
import { PierreFileView } from './PierreFileView';

interface LazyFileDiffProps {
  file: DiffFile;
  baseDiff: FileDiffMetadata;
  forceMount?: boolean;
  scrollRoot: HTMLElement | null;
  reviewBase?: string;
  diffStyle: 'split' | 'unified' | 'old' | 'new';
  options: Record<string, unknown>;
  annotations: DiffLineAnnotation<DiffAnnotationMetadata>[];
  selectedLines: SelectedLineRange | undefined;
  renderAnnotation: (annotation: { lineNumber: number; metadata?: DiffAnnotationMetadata }) => React.ReactNode;
  renderHoverUtility: (getHoveredLine: () => { lineNumber: number; side: 'deletions' | 'additions' } | undefined) => React.ReactNode;
}

function estimateHeight(fileDiff: FileDiffMetadata, diffStyle: 'split' | 'unified' | 'old' | 'new'): number {
  if (diffStyle === 'split') {
    return (fileDiff.splitLineCount * 20) + (fileDiff.hunks.length * 32) + 8;
  }
  return (fileDiff.unifiedLineCount * 20) + (fileDiff.hunks.length * 32) + 8;
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
  renderHoverUtility,
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

  const isSingleFileStyle = diffStyle === 'old' || diffStyle === 'new';
  const singleFileSide = diffStyle === 'old' ? 'deletions' as const : 'additions' as const;

  // Per-file content fetching (same pattern as DiffViewer.tsx)
  const [fileContents, setFileContents] = useState<{ old: string | null; new: string | null } | null>(null);
  const [didLoadFileContents, setDidLoadFileContents] = useState(false);
  useEffect(() => {
    if (!mounted) return;
    setFileContents(null);
    setDidLoadFileContents(false);
    const controller = new AbortController();
    const params = new URLSearchParams({ path: file.path });
    if (file.oldPath) params.set('oldPath', file.oldPath);
    if (reviewBase) params.set('base', reviewBase);
    fetch(`/api/file-content?${params}`, { signal: controller.signal })
      .then(res => res.ok ? res.json() : null)
      .then((data: { oldContent: string | null; newContent: string | null } | null) => {
        setFileContents({ old: data?.oldContent ?? null, new: data?.newContent ?? null });
        setDidLoadFileContents(true);
      })
      .catch(() => {
        setFileContents({ old: null, new: null });
        setDidLoadFileContents(true);
      });
    return () => controller.abort();
  }, [mounted, file.path, file.oldPath, file.patch, reviewBase]);

  const fileDiff = useMemo(() => {
    if (!fileContents || (fileContents.old == null && fileContents.new == null)) return baseDiff;
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

  const changedLineNumbers = useMemo(() => getChangedLineNumbersFromPatch(file.patch), [file.patch]);

  const singleFileAnnotations = useMemo(
    () => annotations
      .filter((annotation) => annotation.side === singleFileSide)
      .map((annotation) => ({
        lineNumber: annotation.lineNumber,
        metadata: annotation.metadata,
      })),
    [annotations, singleFileSide],
  );

  const singleFileSelectedLines = useMemo<PierreSelectedLineRange | undefined>(() => {
    if (!selectedLines || selectedLines.side !== singleFileSide) return undefined;
    return {
      start: Math.min(selectedLines.start, selectedLines.end),
      end: Math.max(selectedLines.start, selectedLines.end),
    };
  }, [selectedLines, singleFileSide]);

  const handleSingleFileLineSelectionEnd = useCallback((range: PierreSelectedLineRange | null) => {
    const onLineSelectionEnd = options.onLineSelectionEnd as ((range: SelectedLineRange | null) => void) | undefined;
    onLineSelectionEnd?.(range ? {
      start: range.start,
      end: range.end,
      side: singleFileSide,
    } : null);
  }, [options, singleFileSide]);

  const renderSingleFileGutterUtility = useCallback((getHoveredLine: () => { lineNumber: number } | undefined) => {
    return renderHoverUtility(() => {
      const line = getHoveredLine();
      return line ? { lineNumber: line.lineNumber, side: singleFileSide } : undefined;
    });
  }, [renderHoverUtility, singleFileSide]);

  const handleSingleFileTokenClick = useCallback((props: any, event: MouseEvent) => {
    const onTokenClick = options.onTokenClick as ((props: any, event: MouseEvent) => void) | undefined;
    onTokenClick?.({ ...props, side: singleFileSide }, event);
  }, [options, singleFileSide]);

  const singleFileContents = diffStyle === 'old' ? fileContents?.old ?? null : fileContents?.new ?? null;
  const singleFileDisplayPath = diffStyle === 'old' ? (file.oldPath || file.path) : file.path;
  const singleFileUnavailableMessage = useMemo(() => {
    if (!didLoadFileContents) return `Loading ${diffStyle} file…`;
    if (fileContents && fileContents.old == null && fileContents.new == null) {
      return 'Unable to load file contents for this view.';
    }
    return diffStyle === 'old'
      ? 'No previous version is available for this file.'
      : 'No new version is available for this file.';
  }, [didLoadFileContents, diffStyle, fileContents]);

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
      {isSingleFileStyle ? (
        !didLoadFileContents || singleFileContents == null ? (
          <div className="rounded-lg border border-border/50 bg-muted/20 px-4 py-6 text-sm text-muted-foreground">
            {singleFileUnavailableMessage}
          </div>
        ) : (
          <PierreFileView
            filePath={file.path}
            displayPath={singleFileDisplayPath}
            contents={singleFileContents}
            pierreTheme={{
              type: options.themeType as 'dark' | 'light',
              css: (options.unsafeCSS as string | undefined) ?? '',
            }}
            overflow={options.overflow as 'scroll' | 'wrap' | undefined}
            diffIndicators={options.diffIndicators as 'bars' | 'classic' | 'none' | undefined}
            disableLineNumbers={options.disableLineNumbers as boolean | undefined}
            disableBackground={options.disableBackground as boolean | undefined}
            changedLineNumbers={diffStyle === 'old' ? changedLineNumbers.oldLines : changedLineNumbers.newLines}
            changedLineType={diffStyle === 'old' ? 'change-deletion' : 'change-addition'}
            lineAnnotations={singleFileAnnotations}
            selectedLines={singleFileSelectedLines}
            renderAnnotation={renderAnnotation}
            renderGutterUtility={renderSingleFileGutterUtility}
            onLineSelectionEnd={handleSingleFileLineSelectionEnd}
            onTokenClick={handleSingleFileTokenClick}
            onTokenEnter={options.onTokenEnter as ((props: any, event: PointerEvent) => void) | undefined}
            onTokenLeave={options.onTokenLeave as ((props: any, event: PointerEvent) => void) | undefined}
          />
        )
      ) : (
        <FileDiff
          fileDiff={fileDiff}
          options={options}
          lineAnnotations={annotations}
          selectedLines={selectedLines}
          renderAnnotation={renderAnnotation}
          renderHoverUtility={renderHoverUtility}
        />
      )}
    </div>
  );
};
