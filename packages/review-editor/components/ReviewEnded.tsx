import { useCallback, useRef, useState } from 'react';
import { copyTextToClipboard } from '@plannotator/ui/utils/clipboard';

/**
 * A local code review whose agent is gone: its server is quitting
 * (`session-closed`, `by: "gone"`, packages/shared/review-agent-gone.ts).
 *
 * The page saves its last edits to the draft at once, then shows the done
 * screen (`CompletionOverlay`) with these words and Copy feedback. The done
 * screen takes the page out of reach, so nothing typed after the server is
 * gone can be lost: every comment is either in the draft or was never typed.
 */
export const REVIEW_ENDED_TITLE = 'Review Ended';

export function reviewEndedSubtitle(savedComments: number): string {
  const ended = 'The agent that asked for this review is gone, so nothing could be sent.';
  if (savedComments <= 0) return ended;
  return `${ended} Your comments are saved as a draft: open a review of the same changes to get them back.`;
}

/**
 * The page's side of the ending: `onGone` flushes the draft (twice, so an
 * edit made while the first save ran is saved too), then reports the end with
 * how many comments the draft holds. `gone` reads true from the event on, so
 * a send made meanwhile says the agent is gone.
 */
export function useAgentGoneEnding(options: { flushDraft: () => Promise<void>; savedComments: () => number }) {
  const latest = useRef(options);
  latest.current = options;
  const gone = useRef(false);
  const [ended, setEnded] = useState<{ savedComments: number } | null>(null);
  const onGone = useCallback(async () => {
    if (gone.current) return;
    gone.current = true;
    await latest.current.flushDraft().catch(() => undefined);
    await latest.current.flushDraft().catch(() => undefined);
    setEnded({ savedComments: latest.current.savedComments() });
  }, []);
  return { gone, ended, onGone };
}

/** Copy feedback on the ended screen: the same text Send would have sent. */
export function ReviewEndedCopy({ copyText }: { copyText: () => string }) {
  const [copied, setCopied] = useState<'idle' | 'copied' | 'failed'>('idle');
  return (
    <div className="flex justify-center">
      <button
        type="button"
        data-review-ended-copy
        className="rounded border border-border px-3 py-1.5 text-sm font-medium text-foreground hover:bg-muted"
        onClick={() => {
          void copyTextToClipboard(copyText()).then((ok) => setCopied(ok ? 'copied' : 'failed'));
        }}
      >
        {copied === 'copied' ? 'Copied' : copied === 'failed' ? 'Copy failed' : 'Copy feedback'}
      </button>
    </div>
  );
}
