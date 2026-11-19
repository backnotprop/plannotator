import { useCallback, useEffect, useRef, useState } from 'react';
import { copyTextToClipboard } from '@plannotator/ui/utils/clipboard';

/**
 * A local code review whose agent is gone: its server is quitting
 * (`session-closed`, `by: "gone"`, packages/shared/review-agent-gone.ts).
 *
 * The page keeps everything before it covers itself:
 * 1. Text typed into a comment box but not added yet (any text box the person
 *    typed in that still holds text, except the AI question boxes, marked
 *    `data-not-a-comment`) is added as a general comment.
 * 2. The draft is saved (twice, so an edit made during the first save is
 *    saved too).
 * 3. The ended screen covers the page, with Copy feedback. It never closes the
 *    tab by itself and never says to go back to the agent.
 * The server stops a second after it announced the end, so these run at once.
 */
export const REVIEW_ENDED_TITLE = 'Review Ended';

export function reviewEndedSubtitle(savedComments: number): string {
  const ended = 'The agent that asked for this review is gone, so nothing could be sent.';
  if (savedComments <= 0) return ended;
  return `${ended} Your comments are saved as a draft: open a review of the same changes to get them back.`;
}

export const REVIEW_ENDED_KEPT_UNFINISHED_TEXT = 'Text you typed but had not added is kept too, as a general comment.';

/**
 * Text boxes the person typed in (an `input` event), so text a box held from
 * the start (a settings field, an export) is never taken for a comment.
 */
export function useTypedTextBoxes(): () => string[] {
  const typed = useRef(new WeakSet<HTMLTextAreaElement>());
  useEffect(() => {
    const onInput = (event: Event) => {
      if (event.target instanceof HTMLTextAreaElement) typed.current.add(event.target);
    };
    document.addEventListener('input', onInput, true);
    return () => document.removeEventListener('input', onInput, true);
  }, []);
  return useCallback(() => {
    const texts: string[] = [];
    for (const box of Array.from(document.querySelectorAll('textarea'))) {
      if (!typed.current.has(box) || box.readOnly || box.disabled || box.closest('[data-not-a-comment]')) continue;
      const text = box.value.trim();
      if (text && !texts.includes(text)) texts.push(text);
    }
    return texts;
  }, []);
}

export interface ReviewEnding {
  savedComments: number;
  keptUnfinished: number;
}

/** Lets React commit the comments just added, so the draft hook's next save carries them. */
const nextRender = () => new Promise<void>((resolve) => setTimeout(resolve, 30));

/**
 * The page's side of the ending (see the top of this file). `gone` reads true
 * from the event on, so a send made meanwhile says the agent is gone.
 */
export function useAgentGoneEnding(options: {
  unfinishedTexts: () => string[];
  /** Adds each text as a general comment; answers how many it added. */
  keepUnfinished: (texts: string[]) => number;
  flushDraft: () => Promise<void>;
  savedComments: () => number;
}) {
  const latest = useRef(options);
  latest.current = options;
  const gone = useRef(false);
  const [ended, setEnded] = useState<ReviewEnding | null>(null);
  const onGone = useCallback(async () => {
    if (gone.current) return;
    gone.current = true;
    const texts = latest.current.unfinishedTexts();
    const keptUnfinished = texts.length > 0 ? latest.current.keepUnfinished(texts) : 0;
    if (keptUnfinished > 0) await nextRender();
    await latest.current.flushDraft().catch(() => undefined);
    await latest.current.flushDraft().catch(() => undefined);
    setEnded({ savedComments: latest.current.savedComments(), keptUnfinished });
  }, []);
  return { gone, ended, onGone };
}

const ChatBubbleIcon = () => (
  <svg className="w-8 h-8" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5} aria-hidden="true">
    <path
      strokeLinecap="round"
      strokeLinejoin="round"
      d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"
    />
  </svg>
);

/** Copy feedback on the ended screen: the same text Send would have sent. */
export function ReviewEndedCopy({ copyText }: { copyText: () => string }) {
  const [copied, setCopied] = useState<'idle' | 'copied' | 'failed'>('idle');
  return (
    <button
      type="button"
      data-review-ended-copy
      className="rounded-md border border-border px-3 py-1.5 text-sm font-medium text-foreground hover:bg-muted"
      onClick={() => {
        void copyTextToClipboard(copyText()).then((ok) => setCopied(ok ? 'copied' : 'failed'));
      }}
    >
      {copied === 'copied' ? 'Copied' : copied === 'failed' ? 'Copy failed' : 'Copy feedback'}
    </button>
  );
}

/**
 * The ended screen. Styled as the done screen (`CompletionOverlay`), but it
 * stays: no auto-close, no countdown, no "return to the agent".
 */
export function ReviewEndedScreen({ ending, copyText }: { ending: ReviewEnding; copyText: () => string }) {
  return (
    <div className="fixed inset-0 z-[100] bg-background flex items-center justify-center overflow-y-auto py-8" data-review-ended role="status">
      <div className="text-center space-y-6 max-w-md px-8">
        <div className="mx-auto w-16 h-16 rounded-full flex items-center justify-center bg-accent/20 text-accent">
          <ChatBubbleIcon />
        </div>
        <div className="space-y-2">
          <h2 className="text-xl font-semibold text-foreground">{REVIEW_ENDED_TITLE}</h2>
          <p className="text-muted-foreground">{reviewEndedSubtitle(ending.savedComments)}</p>
          {ending.keptUnfinished > 0 && <p className="text-sm text-muted-foreground">{REVIEW_ENDED_KEPT_UNFINISHED_TEXT}</p>}
        </div>
        {ending.savedComments > 0 && (
          <div className="pt-4 border-t border-border flex justify-center">
            <ReviewEndedCopy copyText={copyText} />
          </div>
        )}
      </div>
    </div>
  );
}
