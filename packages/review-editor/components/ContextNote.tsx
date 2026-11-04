import React from 'react';
import type { DiffLineAnnotation } from '@pierre/diffs';
import type { CodeAnnotationType, DiffAnnotationMetadata } from '@plannotator/ui/types';
import { renderInlineMarkdown } from '../utils/renderInlineMarkdown';

/**
 * A context note: the review author's "why" for some lines (issue #2588), drawn
 * on the diff beside the reviewer's comments but never one of them. It is not
 * an annotation: nothing selects, edits, counts, exports or posts it.
 */
export interface ContextNote {
  /** Stable within one diff (e.g. `note:<file>:<index>`). */
  id: string;
  filePath: string;
  lineStart: number;
  lineEnd: number;
  side: 'new' | 'old';
  text: string;
}

export const NO_CONTEXT_NOTES: readonly ContextNote[] = [];

/** One file's notes in Pierre's line-annotation shape, drawn under each note's last line. */
export function projectContextNotes(
  notes: readonly ContextNote[],
  filePath: string,
): DiffLineAnnotation<DiffAnnotationMetadata>[] {
  return notes
    .filter((note) => note.filePath === filePath)
    .map((note) => ({
      side: note.side === 'old' ? ('deletions' as const) : ('additions' as const),
      lineNumber: note.lineEnd,
      metadata: {
        annotationId: note.id,
        type: 'comment' as CodeAnnotationType,
        kind: 'context-note' as const,
        text: note.text,
      },
    }));
}

/**
 * The note's card: the comment card's frame, quieted (dashed, no fill, no
 * hover lift, no actions) and labelled "Context" so it never reads as the
 * reviewer's own words.
 */
export const ContextNoteCard: React.FC<{ metadata: DiffAnnotationMetadata }> = ({ metadata }) => (
  <div className="review-comment review-context-note" data-context-note={metadata.annotationId} role="note" aria-label="Context note">
    <div className="review-comment-header">
      <span className="text-[9px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-muted text-muted-foreground/80">Context</span>
    </div>
    {metadata.text && <div className="review-comment-body">{renderInlineMarkdown(metadata.text)}</div>}
  </div>
);
