import { useState } from 'react';
import { createPortal } from 'react-dom';
import { copyTextToClipboard } from '@plannotator/ui/utils/clipboard';

/**
 * A local code review whose agent is gone: its server is quitting
 * (`session-closed`, `by: "gone"`, packages/shared/review-agent-gone.ts) and
 * the draft is kept for the next review of the same changes. The page stays
 * readable; this one line says why nothing can be sent from it now, and Copy
 * feedback takes the comments elsewhere. Same shape as the live review's
 * `LiveEndedBar`.
 */
export const REVIEW_ENDED_TEXT = 'This review has ended because its agent is gone.';
export const REVIEW_ENDED_KEPT_TEXT = 'Your comments are saved and come back when you reopen it.';

export function ReviewEndedBar({ commentCount, copyText }: { commentCount: number; copyText: () => string }) {
  const [copied, setCopied] = useState<'idle' | 'copied' | 'failed'>('idle');
  if (typeof document === 'undefined') return null;
  return createPortal(
    <div role="status" data-review-ended className="fixed bottom-3 left-1/2 z-[1100] flex max-w-[calc(100vw-1.5rem)] -translate-x-1/2 items-center gap-3 rounded border border-border bg-popover px-3 py-1.5 text-[13px] text-foreground">
      <span>{commentCount > 0 ? `${REVIEW_ENDED_TEXT} ${REVIEW_ENDED_KEPT_TEXT}` : REVIEW_ENDED_TEXT}</span>
      {commentCount > 0 && (
        <button
          type="button"
          className="shrink-0 rounded px-1.5 py-0.5 text-[12px] font-medium text-primary hover:bg-muted"
          onClick={() => {
            void copyTextToClipboard(copyText()).then((ok) => setCopied(ok ? 'copied' : 'failed'));
          }}
        >
          {copied === 'copied' ? 'Copied' : copied === 'failed' ? 'Copy failed' : 'Copy feedback'}
        </button>
      )}
    </div>,
    document.body,
  );
}
