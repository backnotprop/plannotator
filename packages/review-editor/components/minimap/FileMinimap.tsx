import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { CodeAnnotation } from '@plannotator/ui/types';
import { isFileScopedAnnotation } from '../../utils/annotationScope';
import { scrollElementLayoutSource, type LineSide } from './layoutSource';
import { DiffMinimapSlot, type MinimapNote } from './DiffMinimapSlot';
import { FILE_HEADER_HEIGHT, HUNK_SEPARATOR_HEIGHT } from '../../utils/diffChromeMetrics';

export interface FileMinimapProps {
  viewport: HTMLElement | null;
  content: HTMLElement | null;
  filePath: string;
  patch: string;
  viewed: boolean;
  annotations: readonly CodeAnnotation[];
  split: boolean;
  expandUnchanged: boolean;
  wholeFile?: { side: LineSide; lineCount: number };
  onShownChange: (shown: boolean) => void;
}

const METRICS = { headerHeight: 0, lineHeight: 20, separatorHeight: HUNK_SEPARATOR_HEIGHT, paddingBottom: 0 };

export const FileMinimap: React.FC<FileMinimapProps> = ({ viewport, content, filePath, patch, viewed, annotations, split, expandUnchanged, wholeFile, onShownChange }) => {
  const pulseRef = useRef<(() => void) | null>(null);
  const [box, setBox] = useState<{ top: number; height: number } | null>(null);

  const source = useMemo(
    () =>
      scrollElementLayoutSource(
        () => viewport,
        () => {
          if (!viewport || !content) return null;
          const offsetTop = content.getBoundingClientRect().top - viewport.getBoundingClientRect().top + viewport.scrollTop;
          return { ids: [filePath], heightOf: () => content.offsetHeight, isCollapsed: () => false, offsetTop };
        },
      ),
    [viewport, content, filePath],
  );

  useEffect(() => {
    if (!viewport) return;
    const read = () => {
      setBox({ top: viewport.offsetTop, height: viewport.offsetHeight });
      pulseRef.current?.();
    };
    read();
    const observer = new ResizeObserver(read);
    observer.observe(viewport);
    if (content) observer.observe(content);
    return () => observer.disconnect();
  }, [viewport, content]);

  const wholeSide = wholeFile?.side;
  const wholeLines = wholeFile?.lineCount;
  const files = useMemo(
    () => [{ id: filePath, path: filePath, patch, ...(wholeSide && wholeLines != null && { wholeFile: { side: wholeSide, lineCount: wholeLines } }) }],
    [filePath, patch, wholeSide, wholeLines],
  );
  const viewedPaths = useMemo(() => (viewed ? new Set([filePath]) : undefined), [viewed, filePath]);
  const notes = useMemo<MinimapNote[]>(
    () => annotations.filter((a) => !isFileScopedAnnotation(a) && (!wholeSide || a.side === wholeSide)).map((a) => ({ filePath, side: a.side, lineStart: a.lineStart, lineEnd: a.lineEnd })),
    [annotations, filePath, wholeSide],
  );

  if (!box) return null;
  return (
    <div className="pointer-events-none absolute right-0 w-6" style={{ top: box.top, height: box.height }}>
      <div className="pointer-events-auto absolute inset-0">
        <DiffMinimapSlot
          source={source}
          files={files}
          viewedPaths={viewedPaths}
          notes={notes}
          metrics={METRICS}
          labelTop={-(FILE_HEADER_HEIGHT + 22) / 2}
          split={split}
          expandUnchanged={expandUnchanged}
          pulseRef={pulseRef}
          onShownChange={onShownChange}
        />
      </div>
    </div>
  );
};
