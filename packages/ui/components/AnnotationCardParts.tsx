// The annotation card's parts, shared by the annotation panel's card
// (AnnotationPanel.tsx) and the contents rail's mark card
// (MarkdownContentsRail.tsx), so both read the same: the type word in its
// colour, "author · time", the quoted text and the comment. Moved out of
// AnnotationPanel.tsx unchanged; AnnotationPanel re-exports them.
import React from 'react';
import { AnnotationType } from '../types';
import { HostTitle } from './HostTitle';

// Card type-word colors. Deletion uses `destructive` (reliably red on every
// theme, matching the in-document .deletion highlight). Comment uses the
// `annotation-comment` token, which defaults to each theme's --accent-text: the
// accent (the colour of the .comment highlight) unless the theme sets a legible
// accent text, as Neutral (both modes) and Quantum Rose light do. "simple"
// overrides it directly to a legible blue.
// Global has no in-document highlight, so it uses a fixed legible purple.
export const ANNOTATION_TYPE_COLOR: Record<AnnotationType, string> = {
  [AnnotationType.DELETION]: 'text-destructive',
  [AnnotationType.COMMENT]: 'text-annotation-comment',
  [AnnotationType.GLOBAL_COMMENT]: 'text-purple-500',
};

export const ANNOTATION_TYPE_LABEL: Record<AnnotationType, string> = {
  [AnnotationType.DELETION]: 'Deletion',
  [AnnotationType.COMMENT]: 'Comment',
  [AnnotationType.GLOBAL_COMMENT]: 'Global',
};

/** The card's quoted text: mono, muted, two lines at most. Wrap the words in quotes. */
export const ANNOTATION_QUOTE_CLASS =
  'mb-1.5 line-clamp-2 whitespace-pre-wrap [overflow-wrap:anywhere] font-mono text-[11px] leading-relaxed text-muted-foreground/80';

/** The card's comment text. */
export const ANNOTATION_TEXT_CLASS =
  'whitespace-pre-wrap [overflow-wrap:anywhere] text-[13px] leading-relaxed text-foreground/90';

export function formatAnnotationTime(ts: number): string {
  const now = Date.now();
  const diff = now - ts;
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (seconds < 60) return 'now';
  if (minutes < 60) return `${minutes}m`;
  if (hours < 24) return `${hours}h`;
  if (days < 7) return `${days}d`;

  // An older date names its year: "Oct 20" alone reads as this October.
  const date = new Date(ts);
  const thisYear = date.getFullYear() === new Date(now).getFullYear();
  return date.toLocaleDateString(
    undefined,
    thisYear ? { month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' },
  );
}

/**
 * A card's "author · time" line. The author truncates (its full name in the
 * title) while the time never shrinks, so a long name cannot push the time
 * out; `<bdi>` keeps a right-to-left name from reordering the time around it.
 * The text reads exactly as before: "Alice (me) · 5m".
 */
export const AnnotationCardByline: React.FC<{ author?: string; isMe: boolean; timestamp: number }> = ({ author, isMe, timestamp }) => (
  <span data-annotation-byline="true" className="flex min-w-0 items-center text-[10px] text-muted-foreground/50">
    {author ? (
      <>
        <HostTitle title={author} cut>
          <span data-annotation-author="true" className="min-w-0 truncate">
            <bdi>{author}</bdi>
          </span>
        </HostTitle>
        {isMe ? <span data-annotation-me="true" className="shrink-0 whitespace-pre"> (me)</span> : null}
        <span className="shrink-0 whitespace-pre"> · </span>
      </>
    ) : null}
    <span data-annotation-time="true" className="shrink-0">{formatAnnotationTime(timestamp)}</span>
  </span>
);
