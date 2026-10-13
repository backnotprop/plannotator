import React from 'react';
import type { AIResponse } from '../../types';
import { SESSION_ASK_ERROR_CODES } from '../../utils/aiProvider';

/** What the reviewer chose on an "Ask this session" answer that could not run. */
export type SessionAskAction = 'wait' | 'interrupt';

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
 * Follow-up under an "Ask this session" error:
 * - the session is busy: ask when it finishes, or interrupt it and ask now;
 * - the session is gone or blocked: a plain note. Ask AI has no other provider
 *   while a session is attached, so there is nothing to switch to.
 * Busy actions render only when the host passes a handler.
 */
export const SessionAskActions: React.FC<{
  response: AIResponse;
  onAction?: (action: SessionAskAction) => void;
}> = ({ response, onAction }) => {
  if (!response.errorCode) return null;

  if (response.errorCode === SESSION_ASK_ERROR_CODES.agentBusy) {
    if (!onAction) return null;
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

  if (response.errorCode === SESSION_ASK_ERROR_CODES.gone || response.errorCode === SESSION_ASK_ERROR_CODES.blocked) {
    const gone = response.errorCode === SESSION_ASK_ERROR_CODES.gone;
    return (
      <p
        className="mt-1.5 text-[11px] text-muted-foreground"
        data-session-ask-unreachable={gone ? 'gone' : 'blocked'}
      >
        {gone
          ? 'Ask AI answers only from the session that opened Plannotator, and that session is gone, so Ask AI can\'t reach it.'
          : 'Ask AI answers only from the session that opened Plannotator, and that session is waiting on this decision, so Ask AI can\'t reach it until you decide.'}
      </p>
    );
  }

  return null;
};

/**
 * A muted note under an "Ask this session" answer that stopped early because
 * the person typed into the session while it answered (the rest of that turn
 * went to their prompt). The partial answer above it stands. Renders nothing
 * for any other response.
 */
export const SessionAskNote: React.FC<{ response: Pick<AIResponse, 'notice'> }> = ({ response }) => {
  if (!response.notice) return null;
  return (
    <p className="mt-1.5 text-[11px] text-muted-foreground" data-session-ask-note="taken-over">
      {response.notice}
    </p>
  );
};
