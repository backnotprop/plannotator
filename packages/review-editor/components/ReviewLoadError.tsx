import React, { useState } from 'react';
import { withServerSession } from '@plannotator/ui/utils/serverSession';

/**
 * What a real review session shows when its first `GET /api/diff` failed.
 *
 * It used to quietly show the built-in demo diff instead, with the decision
 * buttons hidden (they need the session's `origin`), so the person saw a
 * TypeScript file nobody changed and had no way to answer the agent. This
 * screen says what failed, retries the load, and keeps both ways to end the
 * review: feedback to the agent (`/api/feedback`) and Close (`/api/exit`).
 * Neither needs the diff, and both are accepted without a session nonce.
 */
export interface ReviewLoadErrorProps {
  message: string;
  retrying: boolean;
  onRetry: () => void;
  /** `/api/feedback?client=…`, the App's own URL. */
  feedbackUrl: string;
  /** `/api/exit?client=…&`, the App's own URL (ends with `&` or `?`). */
  exitUrl: string;
}

type Outcome = 'feedback' | 'exited';

export const ReviewLoadError: React.FC<ReviewLoadErrorProps> = ({ message, retrying, onRetry, feedbackUrl, exitUrl }) => {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  const run = async (kind: Outcome) => {
    setBusy(true);
    setActionError(null);
    try {
      const res = kind === 'feedback'
        ? await fetch(feedbackUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(withServerSession({ approved: false, feedback: note.trim(), annotations: [] })),
          })
        : await fetch(withExitDraftGeneration(exitUrl), { method: 'POST' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setOutcome(kind);
    } catch {
      setActionError(kind === 'feedback'
        ? 'The feedback could not be sent. The review server may have stopped.'
        : 'The review could not be closed. The review server may have stopped.');
    } finally {
      setBusy(false);
    }
  };

  if (outcome) {
    return (
      <div className="pn-app-viewport flex items-center justify-center bg-background px-6" data-review-load-error="done">
        <div className="max-w-md text-center space-y-2">
          <h1 className="text-sm font-medium text-foreground">
            {outcome === 'feedback' ? 'Feedback sent' : 'Review closed'}
          </h1>
          <p className="text-xs text-muted-foreground">You can close this tab.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="pn-app-viewport flex items-center justify-center bg-background px-6" data-review-load-error="">
      <div role="alert" className="w-full max-w-md space-y-4">
        <div className="space-y-1">
          <h1 className="text-sm font-medium text-destructive">The diff could not be loaded</h1>
          <p className="text-xs text-muted-foreground break-words" data-review-load-error-message="">{message}</p>
        </div>
        <button
          type="button"
          data-pn-touch-target
          onClick={onRetry}
          disabled={retrying || busy}
          className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-60"
        >
          {retrying ? 'Retrying…' : 'Retry'}
        </button>
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
          {actionError && <p className="text-xs text-destructive">{actionError}</p>}
        </div>
      </div>
    </div>
  );
};

/** Close carries a draft generation like the App's own exit; nothing was drafted, so 0. */
function withExitDraftGeneration(exitUrl: string): string {
  return `${exitUrl}draftGeneration=0`;
}
