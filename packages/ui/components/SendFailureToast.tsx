import { useState } from 'react';
import { toast } from 'sonner';
import { copyTextToClipboard } from '../utils/clipboard';
import { canRetrySend, describeSendFailure, sendFailureOf } from '../utils/sendFailure';

let failures = 0;
let currentId: string | null = null;
let inFlight = 0;

export function sendStarted(): void {
  inFlight += 1;
  dismissSendFailureToast();
}

export function sendSettled(): void {
  inFlight = Math.max(0, inFlight - 1);
}

export function dismissSendFailureToast(): void {
  if (currentId === null) return;
  toast.dismiss(currentId);
  currentId = null;
}

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
  what: 'feedback' | 'approval';
  error: unknown;
  onRetry: () => void;
  copyText?: () => string | undefined;
}): void {
  const { what, error, onRetry, copyText } = options;
  const failure = sendFailureOf(error);
  dismissSendFailureToast();
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
    position: 'bottom-center',
    closeButton: true,
    cancel: copyText ? <CopyFeedbackButton getText={copyText} /> : undefined,
    action: canRetrySend(failure)
      ? {
          label: 'Retry',
          onClick: () => {
            if (inFlight > 0) return;
            onRetry();
          },
        }
      : undefined,
    classNames: {
      toast: 'sm:!w-[420px] sm:![margin-left:calc((var(--width)_-_420px)_/_2)]',
      description: '!text-foreground/70',
    },
  });
}
