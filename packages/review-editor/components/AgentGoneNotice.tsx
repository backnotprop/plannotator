import { toast } from 'sonner';
import { AGENT_AWAY_REASON, AGENT_GONE_REASON, NO_SESSION_REASON } from '@plannotator/shared/review-agent-gone-words';
import { CopyFeedbackButton } from '@plannotator/ui/components/SendFailureToast';
import { sendFailureOf } from '@plannotator/ui/utils/sendFailure';

/**
 * A code review whose agent is gone (`agent-gone` on the external-annotations
 * stream, packages/shared/review-agent-gone.ts): nothing can receive its
 * decision. The page says so at once, before any Send, and stays as it is:
 * every comment on screen and in the draft, which keeps saving, so a reload
 * brings them back. Copy feedback copies what Send would send. The notice
 * stays until dismissed or the agent is back; a Send refused because the
 * agent is gone takes it down, since the failure toast says the same with
 * the same Copy feedback.
 *
 * Each notice gets its own id (see SendFailureToast.tsx: a reused id races
 * sonner's dismissal).
 */
let currentId: string | null = null;
let notices = 0;

export function showAgentGoneNotice(options: { copyText: () => string | undefined }): void {
  if (currentId !== null) return;
  const id = `plannotator-agent-gone-${++notices}`;
  currentId = id;
  toast.warning(AGENT_GONE_REASON, {
    id,
    onDismiss: () => {
      if (currentId === id) currentId = null;
    },
    duration: Infinity,
    // Where the send failure toast sits: clear of the header and the panel.
    position: 'bottom-center',
    closeButton: true,
    cancel: <CopyFeedbackButton getText={options.copyText} />,
    classNames: {
      toast: 'sm:!w-[420px] sm:![margin-left:calc((var(--width)_-_420px)_/_2)]',
    },
  });
}

/** The agent is back, or the review was decided. */
export function dismissAgentGoneNotice(): void {
  if (currentId === null) return;
  toast.dismiss(currentId);
  currentId = null;
}

/** A Send failed: when it failed because the agent is gone, its own toast says so. */
export function noteSendFailureForAgentGone(error: unknown): void {
  if (sendFailureOf(error).kind === 'agent-gone') dismissAgentGoneNotice();
}

/** The reason a failed Send shows when nobody could receive it (packages/shared/review-agent-gone-words.ts). */
export function agentGoneReasonFor(error: unknown): string | undefined {
  switch (sendFailureOf(error).kind) {
    case 'agent-gone':
      return AGENT_GONE_REASON;
    case 'agent-away':
      return AGENT_AWAY_REASON;
    case 'no-session':
      return NO_SESSION_REASON;
    default:
      return undefined;
  }
}
