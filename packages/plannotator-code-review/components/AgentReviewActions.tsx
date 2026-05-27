import React from 'react';
import { FeedbackButton, ApproveButton, ExitButton } from '@plannotator/ui/components/ToolbarButtons';

interface AgentReviewActionsProps {
  totalAnnotationCount: number;
  isSendingFeedback: boolean;
  isApproving: boolean;
  isExiting: boolean;
  onSendFeedback: () => void;
  onApprove: () => void;
  onExit: () => void;
}

/**
 * Toolbar actions for agent review mode (all non-platform origins).
 *
 * The left button flips based on whether there are annotations:
 *   No annotations → [Close]  [Approve]
 *   Has annotations → [Send Feedback]  [Approve]
 *
 * - Close (Exit): closes the session without sending feedback
 * - Send Feedback: primary action when annotations exist
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
}) => {
  const busy = isSendingFeedback || isApproving || isExiting;
  const hasAnnotations = totalAnnotationCount > 0;

  return (
    <>
      <ExitButton
        onClick={onExit}
        disabled={busy}
        isLoading={isExiting}
      />

      {hasAnnotations && (
        <FeedbackButton
          onClick={onSendFeedback}
          disabled={busy}
          isLoading={isSendingFeedback}
          label="Send Feedback"
          shortLabel="Send"
          loadingLabel="Sending..."
          title="Send feedback"
        />
      )}

      <div className="relative group/approve inline-flex items-center">
        <ApproveButton
          onClick={onApprove}
          disabled={busy}
          isLoading={isApproving}
          dimmed={totalAnnotationCount > 0}
          title="Approve - no changes needed"
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
