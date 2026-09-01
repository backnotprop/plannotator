import React from 'react';
import { FeedbackButton, ApproveButton, ExitButton } from '@plannotator/ui/components/ToolbarButtons';
import { ReviewSendControl, type ReviewSubmitNoteControl } from './ReviewSendControl';

interface AgentReviewActionsProps {
  totalAnnotationCount: number;
  isSendingFeedback: boolean;
  isApproving: boolean;
  isExiting: boolean;
  onSendFeedback: () => void;
  onApprove: () => void;
  onExit: () => void;
  /** Enables the note half of the split Send control. Omitted (a host that
   *  does not wire a note) falls back to the incumbent FeedbackButton. */
  note?: ReviewSubmitNoteControl;
}

/**
 * Toolbar actions for agent review mode (all non-platform origins).
 *
 * - Close (Exit): closes the session without sending feedback
 * - Send Feedback: the incumbent send. With a `note` it is the left segment of
 *   a split pill whose caret opens a review-level note composer; the segment's
 *   label, icon, breakpoints and handler are unchanged either way, and with no
 *   note wired it is the plain FeedbackButton shown only when annotations
 *   exist.
 * - Approve: LGTM; dimmed when annotations exist (they won't be sent)
 */
export const AgentReviewActions: React.FC<AgentReviewActionsProps> = ({
  totalAnnotationCount,
  isSendingFeedback,
  isApproving,
  isExiting,
  onSendFeedback,
  onApprove,
  onExit,
  note,
}) => {
  const busy = isSendingFeedback || isApproving || isExiting;
  const hasAnnotations = totalAnnotationCount > 0;

  return (
    <>
      <ExitButton
        onClick={onExit}
        disabled={busy}
        isLoading={isExiting}
        labelBreakpoint="lg"
      />

      {note ? (
        <ReviewSendControl
          hasFeedback={hasAnnotations}
          disabled={busy}
          isLoading={isSendingFeedback}
          onSend={onSendFeedback}
          note={note}
        />
      ) : hasAnnotations ? (
        <FeedbackButton
          onClick={onSendFeedback}
          disabled={busy}
          isLoading={isSendingFeedback}
          label="Send Feedback"
          shortLabel="Send"
          loadingLabel="Sending..."
          title="Send feedback"
          labelBreakpoint="lg"
        />
      ) : null}

      <div className="relative group/approve inline-flex items-center">
        <ApproveButton
          onClick={onApprove}
          disabled={busy}
          isLoading={isApproving}
          dimmed={totalAnnotationCount > 0}
          title="Approve - no changes needed"
          labelBreakpoint="lg"
        />
        {totalAnnotationCount > 0 && (
          <div className="absolute top-full right-0 mt-2 px-3 py-2 bg-popover border border-border rounded-lg shadow-xl text-xs text-foreground w-56 text-center opacity-0 invisible group-hover/approve:opacity-100 group-hover/approve:visible transition-all pointer-events-none z-50">
            <div className="absolute bottom-full right-4 border-4 border-transparent border-b-border" />
            <div className="absolute bottom-full right-4 mt-px border-4 border-transparent border-b-popover" />
            Your {totalAnnotationCount} annotation{totalAnnotationCount !== 1 ? 's' : ''} won't be sent if you approve.
          </div>
        )}
      </div>
    </>
  );
};
