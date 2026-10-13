import type { Annotation } from '@plannotator/ui/types';
import type { RestoredAnchor } from '@plannotator/ui/hooks/useAnnotationHighlighter';
import { annotationOwnsHighlight } from '@plannotator/ui/utils/annotationOwnsHighlight';

/**
 * Write a restore pass's `moved` anchors back onto the annotations, so the
 * export's line labels (read from `blockId`) name where each comment's text is
 * now rather than where it was when the comment was made.
 *
 * - A comment whose text landed in another block takes that block's id and
 *   offsets; its stored positions are dropped when they did not lead to the
 *   text (the next restore then searches by text, as this one did).
 * - A comment whose text is gone gets `blockId: ''` — the same "no longer in
 *   the document" value Edit Mode's remap uses — so it exports with no line
 *   label instead of a confident wrong one, and drops its stale positions.
 *
 * Only rows that own a text highlight are touched (`annotationOwnsHighlight`:
 * not diff-view comments, checkbox toggles or question answers). Returns
 * the SAME array when nothing changes, so an unchanged document causes no
 * state update (and no draft save).
 */
export function applyRestoredAnchors(
  annotations: Annotation[],
  moved: readonly RestoredAnchor[] | undefined,
): Annotation[] {
  if (!moved || moved.length === 0) return annotations;
  const byId = new Map(moved.map((entry) => [entry.id, entry]));
  let changed = false;
  const next = annotations.map((ann) => {
    const entry = byId.get(ann.id);
    // Only text highlights move: a diff-view comment's `diff-block-N`, a
    // checkbox toggle's block key and a question answer's anchor are not
    // positions in the rendered text, whatever a restore pass reported.
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
