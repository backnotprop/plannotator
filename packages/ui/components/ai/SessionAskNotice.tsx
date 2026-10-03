import React from 'react';
import type { AIResponse } from '../../types';
import { SESSION_ASK_ERROR_CODES } from '../../utils/aiProvider';

/** What the reviewer chose on an "Ask this session" answer that could not run. */
export type SessionAskAction = 'wait' | 'interrupt' | 'fallback';

/**
 * In-progress line for a question waiting on a busy session. Renders nothing
 * for any other response, so providers without a bridge are unaffected.
 */
export const SessionAskStatus: React.FC<{ response: AIResponse }> = ({ response }) => {
  if (!response.status) return null;
  return (
    <span className="text-xs text-muted-foreground" data-session-ask-status={response.status}>
      <span className="ai-streaming-cursor" />{' '}
      {response.status === 'waiting'
        ? 'Waiting for the session to finish its current turn…'
        : 'Interrupting the session…'}
    </span>
  );
};

/**
 * Colour for an answer's error line: a busy session is a choice, not a
 * failure, so it reads muted; every other error keeps the destructive tone.
 */
export function sessionAskErrorTone(response: Pick<AIResponse, 'errorCode'>): string {
  return response.errorCode === SESSION_ASK_ERROR_CODES.agentBusy ? 'text-muted-foreground' : 'text-destructive';
}

const buttonClass =
  'px-2 py-1 rounded-md text-[10px] font-medium transition-colors';

/**
 * Follow-up actions under an "Ask this session" error:
 * - the session is busy: ask when it finishes, or interrupt it and ask now;
 * - the session is gone or blocked: ask a separate AI instead.
 * Renders nothing for other errors or when the host passes no handler.
 */
export const SessionAskActions: React.FC<{
  response: AIResponse;
  onAction?: (action: SessionAskAction) => void;
  /** Label of the provider the fallback would use; null hides the fallback. */
  fallbackLabel?: string | null;
}> = ({ response, onAction, fallbackLabel }) => {
  if (!onAction || !response.errorCode) return null;

  if (response.errorCode === SESSION_ASK_ERROR_CODES.agentBusy) {
    return (
      <div className="flex flex-wrap gap-1.5 mt-2" data-session-ask-actions="busy">
        <button
          type="button"
          onClick={() => onAction('wait')}
          className={`${buttonClass} bg-primary text-primary-foreground hover:opacity-90`}
        >
          Ask when it finishes
        </button>
        <button
          type="button"
          onClick={() => onAction('interrupt')}
          className={`${buttonClass} bg-muted text-foreground hover:bg-muted/80`}
          title="Stops the session's current work, then asks your question"
        >
          Interrupt and ask now
        </button>
      </div>
    );
  }

  if (
    (response.errorCode === SESSION_ASK_ERROR_CODES.gone || response.errorCode === SESSION_ASK_ERROR_CODES.blocked) &&
    fallbackLabel
  ) {
    return (
      <div className="flex flex-wrap gap-1.5 mt-2" data-session-ask-actions="fallback">
        <button
          type="button"
          onClick={() => onAction('fallback')}
          className={`${buttonClass} bg-muted text-foreground hover:bg-muted/80`}
        >
          Ask a separate AI instead ({fallbackLabel})
        </button>
      </div>
    );
  }

  return null;
};
