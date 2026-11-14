import React, { useMemo } from 'react';
import type { CodeAnnotation } from '@plannotator/ui/types';
import { isFileScopedAnnotation } from '../../utils/annotationScope';
import { codeViewLayoutSource, scrollElementLayoutSource, withFallback, type ScrollElementModel } from './layoutSource';
import { DiffMinimapSlot, type MinimapFileInput, type MinimapNote } from './DiffMinimapSlot';
import type { RowMetrics } from './rowModel';

export interface CodeViewMinimapProps {
  getViewer: () => unknown;
  getScrollElement: () => HTMLElement | null;
  items: readonly { id: string }[];
  itemIdToFile: ReadonlyMap<string, { path: string; patch: string }>;
  viewedFiles: ReadonlySet<string> | undefined;
  annotations: readonly CodeAnnotation[];
  metrics: RowMetrics;
  split: boolean;
  expandUnchanged: boolean;
  pulseRef: React.MutableRefObject<(() => void) | null>;
  onShownChange: (shown: boolean) => void;
}

export const CodeViewMinimap: React.FC<CodeViewMinimapProps> = ({ getViewer, getScrollElement, items, itemIdToFile, viewedFiles, annotations, metrics, split, expandUnchanged, pulseRef, onShownChange }) => {
  const ids = useMemo(() => items.map((item) => item.id), [items]);
  const fallbackModel = useMemo(() => ({ current: null as ScrollElementModel | null }), []);
  const source = useMemo(
    () => withFallback(codeViewLayoutSource(getViewer, ids, { paddingBottom: metrics.paddingBottom }), scrollElementLayoutSource(getScrollElement, () => fallbackModel.current)),
    [getViewer, getScrollElement, ids, metrics.paddingBottom, fallbackModel],
  );
  const files = useMemo<MinimapFileInput[]>(
    () => ids.flatMap((id) => {
      const file = itemIdToFile.get(id);
      return file ? [{ id, path: file.path, patch: file.patch }] : [];
    }),
    [ids, itemIdToFile],
  );
  const notes = useMemo<MinimapNote[]>(
    () => annotations.filter((a) => !isFileScopedAnnotation(a)).map((a) => ({ filePath: a.filePath, side: a.side, lineStart: a.lineStart, lineEnd: a.lineEnd })),
    [annotations],
  );
  return (
    <DiffMinimapSlot
      source={source}
      fallbackModel={fallbackModel}
      files={files}
      viewedPaths={viewedFiles}
      notes={notes}
      metrics={metrics}
      split={split}
      expandUnchanged={expandUnchanged}
      pulseRef={pulseRef}
      onShownChange={onShownChange}
    />
  );
};
