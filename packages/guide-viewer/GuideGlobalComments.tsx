import React, { useRef } from 'react';
import type { GuideGlobalComments } from './host';

/** The globe Plannotator's document viewer draws on its "Global comment" button. */
const GlobeIcon: React.FC = () => (
  <svg className="h-3.5 w-3.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true">
    <path
      strokeLinecap="round"
      strokeLinejoin="round"
      d="M12 21a9.004 9.004 0 008.716-6.747M12 21a9.004 9.004 0 01-8.716-6.747M12 21c2.485 0 4.5-4.03 4.5-9S14.485 3 12 3m0 18c-2.485 0-4.5-4.03-4.5-9S9.515 3 12 3m0 0a8.997 8.997 0 017.843 4.582M12 3a8.997 8.997 0 00-7.843 4.582m15.686 0A11.953 11.953 0 0112 10.5c-2.998 0-5.74-1.1-7.843-2.918m15.686 0A8.959 8.959 0 0121 12c0 .778-.099 1.533-.284 2.253m0 0A17.919 17.919 0 0112 16.5c-3.162 0-6.133-.815-8.716-2.247m0 0A9.015 9.015 0 013 12c0-1.605.42-3.113 1.157-4.418"
    />
  </svg>
);

/**
 * The guide header's "Global comment" button: the same words, icon and look
 * as the document viewer's (packages/ui/components/Viewer.tsx), so a global
 * comment reads as one thing across Plannotator. The host's composer opens
 * anchored to it.
 */
export const GuideGlobalCommentButton: React.FC<{ onAdd: (anchor: HTMLElement) => void }> = ({ onAdd }) => {
  const ref = useRef<HTMLButtonElement>(null);
  return (
    <button
      ref={ref}
      type="button"
      data-guide-global-comment-add=""
      onClick={() => ref.current && onAdd(ref.current)}
      title="Add global comment"
      className="flex min-w-0 max-w-full items-center gap-1.5 rounded-md bg-muted/50 px-2.5 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
    >
      <GlobeIcon />
      {/* Cut with "…" only where the row is narrower than the button (the tab's row in a narrow bare guide). */}
      <span className="truncate">Global comment</span>
    </button>
  );
};

/**
 * The review's global comments, under the guide's header and before its first
 * section: a comment on the whole review sits at the top of it, as a line
 * comment sits at its line. Choosing one shows it where the host lists
 * comments (its edit and delete are there).
 */
export const GuideGlobalCommentList: React.FC<{ globalComments: GuideGlobalComments }> = ({ globalComments }) => {
  const { comments, onSelect, selectedId } = globalComments;
  if (comments.length === 0) return null;
  return (
    <section className="mt-5 max-w-[72ch]" aria-label="Global comments" data-guide-global-comments={comments.length}>
      <h2 className="flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
        <GlobeIcon />
        Global comments
        <span className="font-mono text-muted-foreground/60">{comments.length}</span>
      </h2>
      <ul className="mt-2 space-y-1.5">
        {comments.map((comment) => {
          const selected = comment.id === selectedId;
          const body = (
            <p className="whitespace-pre-wrap text-[13px] leading-relaxed text-foreground/90 [overflow-wrap:anywhere]">{comment.text}</p>
          );
          return (
            <li key={comment.id} data-guide-global-comment={comment.id}>
              {onSelect ? (
                <button
                  type="button"
                  onClick={() => onSelect(comment.id)}
                  aria-current={selected || undefined}
                  className={`w-full rounded-lg border px-3 py-2 text-left transition-colors ${
                    selected ? 'border-primary/40 bg-primary/5' : 'border-border/60 bg-card hover:bg-muted/40'
                  }`}
                >
                  {body}
                </button>
              ) : (
                <div className="rounded-lg border border-border/60 bg-card px-3 py-2">{body}</div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
};
