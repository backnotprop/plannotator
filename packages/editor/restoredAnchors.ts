import type { Annotation } from '@plannotator/ui/types';
import type { RestoredAnchor } from '@plannotator/ui/hooks/useAnnotationHighlighter';
import { annotationOwnsHighlight } from '@plannotator/ui/utils/annotationOwnsHighlight';

export function applyRestoredAnchors(
  annotations: Annotation[],
  moved: readonly RestoredAnchor[] | undefined,
): Annotation[] {
  if (!moved || moved.length === 0) return annotations;
  const byId = new Map(moved.map((entry) => [entry.id, entry]));
  let changed = false;
  const next = annotations.map((ann) => {
    const entry = byId.get(ann.id);
    if (!entry || !annotationOwnsHighlight(ann)) return ann;
    const dropPositions = entry.positionsStale && (ann.startMeta !== undefined || ann.endMeta !== undefined);
    const offsetsChange = entry.blockId !== '' && entry.startOffset !== undefined
      && entry.startOffset !== ann.startOffset;
    if (entry.blockId === ann.blockId && !dropPositions && !offsetsChange) return ann;
    changed = true;
    const updated: Annotation = { ...ann, blockId: entry.blockId };
    if (offsetsChange && entry.startOffset !== undefined) {
      updated.startOffset = entry.startOffset;
      updated.endOffset = entry.startOffset + ann.originalText.length;
    }
    if (dropPositions) {
      delete updated.startMeta;
      delete updated.endMeta;
    }
    return updated;
  });
  return changed ? next : annotations;
}
