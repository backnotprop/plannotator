import React from 'react';
import type { ConventionalLabel, ConventionalDecoration } from '@plannotator/ui/types';
import { isCurrentUser } from '@plannotator/ui/utils/identity';
import { ConventionalLabelBadge } from './ConventionalLabelPicker';
import { formatRelativeTime } from '../utils/formatRelativeTime';

interface CommentMetaProps {
  /** Surface-specific leading element(s): severity dot, scope/file/line badge,
   *  collapse toggle, etc. Rendered first in the left cluster. */
  leading?: React.ReactNode;
  conventionalLabel?: ConventionalLabel | null;
  decorations?: ConventionalDecoration[];
  reviewProfileLabel?: string;
  source?: string;
  author?: string;
  createdAt?: number;
}

/**
 * The single identity row shared by every comment surface — the inline diff
 * card, the sidebar list, and the file-comment banner. Left cluster: leading
 * badge(s) → conventional label → review-profile/source badge → author. Right:
 * relative time, then any surface-specific actions. Centralizing it keeps author
 * + timestamp + badge styling identical everywhere (they used to be hand-rolled
 * three different ways).
 */
export const CommentMeta: React.FC<CommentMetaProps> = ({
  leading,
  conventionalLabel,
  decorations,
  reviewProfileLabel,
  source,
  author,
  createdAt,
}) => (
  <div className="review-comment-header">
    <div className="flex min-w-0 items-center gap-1.5">
      {leading}
      {conventionalLabel && (
        <ConventionalLabelBadge label={conventionalLabel} decorations={decorations} />
      )}
      {reviewProfileLabel ? (
        <span className="text-[9px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-accent/10 text-accent/90 truncate max-w-[140px]">
          {reviewProfileLabel}
        </span>
      ) : source ? (
        <span className="text-[9px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-muted text-muted-foreground/80 truncate max-w-[140px]">
          {source}
        </span>
      ) : null}
      {author && (
        <span
          className={`text-[10px] truncate max-w-[120px] ${
            isCurrentUser(author) ? 'text-muted-foreground/50' : 'text-muted-foreground/70'
          }`}
        >
          {author}
          {isCurrentUser(author) && ' (me)'}
        </span>
      )}
    </div>
    {createdAt != null && (
      <span className="ml-auto flex-none text-[10px] text-muted-foreground/50">
        {formatRelativeTime(createdAt)}
      </span>
    )}
  </div>
);
