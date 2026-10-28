import { useState } from 'react';
import { toast } from 'sonner';
import { copyTextToClipboard } from '../utils/clipboard';
import { canRetrySend, describeSendFailure, sendFailureOf } from '../utils/sendFailure';

/**
 * The one message a review page shows when a decision did not reach the
 * agent (#1392): which decision, why, Retry, and Copy feedback. It stays until
 * dismissed (the person may not be looking when it fails) and a second
 * failure replaces it rather than stacking. The page itself is untouched:
 * the handlers that call this keep every annotation and never show a
 * "sent" screen.
 *
 * The handlers bracket every send with `sendStarted()` / `sendSettled()`: a
 * new send takes the message down (it no longer describes the page), and
 * Retry does nothing while a send is in flight, so it can never post a
 * second decision beside the one already going.
 */

/**
 * Each failure is a new toast with its own id, and the one before it is
 * dismissed. Reusing one id races sonner: a dismissal reaches the Toaster a
 * frame or two late, so a failure that lands within that window (a refused
 * connection fails in milliseconds) would be marked deleted as it appears.
 */
let failures = 0;
/** The failure toast on screen, if any. */
let currentId: string | null = null;
/** Decision sends in flight on this page. */
let inFlight = 0;

/** A decision send begins: the old failure no longer applies. */
export function sendStarted(): void {
  inFlight += 1;
  dismissSendFailureToast();
}

/** A decision send ended, however it ended. */
export function sendSettled(): void {
  inFlight = Math.max(0, inFlight - 1);
}

/** The failure no longer applies (a send started, or the review was decided). */
export function dismissSendFailureToast(): void {
  if (currentId === null) return;
  toast.dismiss(currentId);
  currentId = null;
}

/**
 * Copy feedback stays inside the toast after a click (a plain sonner `cancel`
 * button would close it and take the failure message with it). The data
 * attributes give it sonner's own secondary-button shape; the colors come
 * from the theme, since the Toasters run sonner's light theme and its
 * secondary fill disappears on a dark card.
 */
function CopyFeedbackButton({ getText }: { getText: () => string | undefined }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  return (
    <button
      type="button"
      data-button=""
      data-cancel=""
      data-send-failure-copy=""
      className="!bg-foreground/10 !text-foreground"
      onClick={() => {
        const text = getText();
        if (!text) {
          setState('failed');
          return;
        }
        void copyTextToClipboard(text).then((copied) => setState(copied ? 'copied' : 'failed'));
      }}
    >
      {state === 'copied' ? 'Copied' : state === 'failed' ? 'Copy failed' : 'Copy feedback'}
    </button>
  );
}

export function showSendFailureToast(options: {
  /** What did not go out: names the toast's title. */
  what: 'feedback' | 'approval';
  /** The error the send threw (`DecisionSendError` says why). */
  error: unknown;
  /** Sends the same decision again, from the page as it is now. */
  onRetry: () => void;
  /** The text Retry would send now, as the page's Copy feedback copies it.
   *  Omitted when the decision carries no text (a bare approval). */
  copyText?: () => string | undefined;
}): void {
  const { what, error, onRetry, copyText } = options;
  const failure = sendFailureOf(error);
  dismissSendFailureToast(); // replaced, never stacked
  const id = `plannotator-send-failure-${++failures}`;
  currentId = id;
  const forget = () => {
    if (currentId === id) currentId = null;
  };
  toast.error(what === 'approval' ? 'Approval not sent' : 'Feedback not sent', {
    id,
    onDismiss: forget,
    description: describeSendFailure(failure),
    duration: Infinity,
    // It stays up, so it sits at the bottom, clear of the header's decision
    // control and the annotation panel the reviewer may want to read.
    position: 'bottom-center',
    closeButton: true,
    cancel: copyText ? <CopyFeedbackButton getText={copyText} /> : undefined,
    // An already-decided review cannot take the decision again.
    action: canRetrySend(failure)
      ? {
          label: 'Retry',
          onClick: () => {
            if (inFlight > 0) return;
            onRetry();
          },
        }
      : undefined,
    // 420px on a desktop (sonner's 356px wraps the reason onto three lines),
    // re-centred on sonner's column; phones keep sonner's full-width layout.
    classNames: {
      toast: 'sm:!w-[420px] sm:![margin-left:calc((var(--width)_-_420px)_/_2)]',
      description: '!text-foreground/70',
    },
  });
}
