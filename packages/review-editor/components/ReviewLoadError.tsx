import React, { useEffect, useRef, useState } from 'react';
import { withServerSession } from '@plannotator/ui/utils/serverSession';
import { assertSendOk, describeSendFailure, sendFailureOf, throwUnreachable } from '@plannotator/ui/utils/sendFailure';
import type { DiffLoadFailureInfo } from '../utils/diffLoadFailure';

/**
 * What a real review session shows when its first `GET /api/diff` failed.
 *
 * It used to quietly show the built-in demo diff instead, with the decision
 * buttons hidden (they need the session's `origin`), so the person saw a
 * TypeScript file nobody changed and had no way to answer the agent. This
 * screen says what failed and retries the load. When the review server is
 * alive and failed to build the diff (a 5xx, `failure.canDecide`), it also
 * keeps both ways to end the review: a note sent as feedback
 * (`/api/feedback`) and Close (`/api/exit`). Otherwise it offers Retry only:
 * those requests carry no session nonce, so on a reused port they could end a
 * different session.
 */
export interface ReviewLoadErrorProps {
  failure: DiffLoadFailureInfo;
  retrying: boolean;
  onRetry: () => void;
  /** `/api/feedback?client=…`, the App's own URL. */
  feedbackUrl: string;
  /** `/api/exit?client=…&`, the App's own URL (ends with `&` or `?`). */
  exitUrl: string;
  /** The agent switch a normal decision sends (OpenCode), read when sending. */
  getAgentSwitch: () => string | undefined;
}

type Outcome = 'feedback' | 'exited';

export const ReviewLoadError: React.FC<ReviewLoadErrorProps> = ({ failure, retrying, onRetry, feedbackUrl, exitUrl, getAgentSwitch }) => {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const retryRef = useRef<HTMLButtonElement>(null);

  // Focus Retry when the screen appears (the reason is announced by its
  // alert), and the heading once it turns into the outcome, so keyboard and
  // screen reader users are never left on <body>.
  useEffect(() => {
    if (outcome) headingRef.current?.focus();
    else retryRef.current?.focus();
  }, [outcome]);

  const run = async (kind: Outcome) => {
    setBusy(true);
    setActionError(null);
    try {
      let res: Response;
      if (kind === 'feedback') {
        const agentSwitch = getAgentSwitch();
        res = await fetch(feedbackUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          // draftGeneration 0, like Close: a server draft saved by an earlier
          // load (generation 1 and up) is kept, never deleted unseen.
          body: JSON.stringify(withServerSession({
            draftGeneration: 0,
            approved: false,
            feedback: note.trim(),
            annotations: [],
            ...(agentSwitch && { agentSwitch }),
          })),
        }).catch(throwUnreachable);
      } else {
        res = await fetch(`${exitUrl}draftGeneration=0`, { method: 'POST' }).catch(throwUnreachable);
      }
      await assertSendOk(res);
      setOutcome(kind);
    } catch (error) {
      setActionError(`${describeSendFailure(sendFailureOf(error))} Nothing was sent.`);
    } finally {
      setBusy(false);
    }
  };

  if (outcome) {
    return (
      <div className="pn-app-viewport flex items-center justify-center bg-background px-6" data-review-load-error="done">
        <div role="status" className="max-w-md text-center space-y-2">
          <h1 ref={headingRef} tabIndex={-1} className="text-sm font-medium text-foreground outline-none">
            {outcome === 'feedback' ? 'Feedback sent' : 'Review closed'}
          </h1>
          <p className="text-xs text-muted-foreground">You can close this tab.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="pn-app-viewport flex items-center justify-center bg-background px-6" data-review-load-error="">
      <div className="w-full max-w-md space-y-4">
        <div className="space-y-1.5">
          <h1 className="text-sm font-medium text-foreground">
            This review could not load
          </h1>
          <div role="alert" className="space-y-1">
            <p className="text-sm text-muted-foreground" data-review-load-error-message="">{failure.summary}</p>
            {failure.detail && (
              <p className="text-xs text-muted-foreground/80 font-mono break-words" data-review-load-error-detail="">
                {failure.detail}
              </p>
            )}
          </div>
        </div>
        <button
          ref={retryRef}
          type="button"
          data-pn-touch-target
          onClick={onRetry}
          disabled={retrying || busy}
          className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-60"
        >
          {retrying ? 'Retrying…' : 'Retry'}
        </button>
        {failure.canDecide && (
          <div className="space-y-2 border-t border-border pt-4">
            <label htmlFor="review-load-error-note" className="block text-xs text-muted-foreground">
              Or answer the agent without the diff:
            </label>
            <textarea
              id="review-load-error-note"
              value={note}
              onChange={(event) => setNote(event.target.value)}
              rows={3}
              className="w-full resize-y rounded-md border border-border bg-background px-2 py-1.5 text-xs text-foreground"
              placeholder="Feedback for the agent"
            />
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                data-pn-touch-target
                onClick={() => void run('feedback')}
                disabled={busy || !note.trim()}
                className="rounded-md bg-muted px-3 py-1.5 text-xs font-medium text-foreground hover:bg-muted/80 disabled:opacity-60"
              >
                Send Feedback
              </button>
              <button
                type="button"
                data-pn-touch-target
                onClick={() => void run('exited')}
                disabled={busy}
                className="rounded-md px-3 py-1.5 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-60"
              >
                Close review
              </button>
            </div>
            {actionError && <p role="alert" className="text-xs text-destructive">{actionError}</p>}
          </div>
        )}
      </div>
    </div>
  );
};
