/**
 * Every word a person reads when the agent that asked for a code review is
 * gone, or cannot take its decision right now (packages/shared/review-agent-gone.ts).
 * Kept in this one file because the owner approves them: change a sentence
 * here, nowhere else.
 *
 * Read by the review servers' refusal (Bun and Pi, through
 * packages/shared/review-agent-gone.ts), the review page (packages/ui/utils/sendFailure.ts,
 * packages/ui/components/SendFailureToast.tsx), and the CLI
 * (apps/hook/server/review-agent-watch.ts). The Claude Code mod imports
 * nothing outside its own folder, so its one line is a copy of
 * `REVIEW_AGENT_GONE_MOD_LOG` (apps/hook/hooks/mod/controller.ts).
 */

/** The refusal codes `/api/feedback` answers with (both servers), read by the page. */
export const AGENT_GONE_CODE = "agent_gone";
export const AGENT_AWAY_CODE = "agent_away";
export const NO_SESSION_CODE = "no_session";

/** The server's refusal `error` (410 agent_gone, 409 agent_away, 410 no_session). */
export const AGENT_GONE_REFUSAL_ERROR = "The agent that asked for this review is gone. Nothing was sent; your comments are kept.";
export const AGENT_AWAY_REFUSAL_ERROR = "No agent session can receive this right now. Nothing was sent; your comments are kept.";
export const NO_SESSION_REFUSAL_ERROR = "This review has no agent session to send to. Nothing was sent; your comments are kept.";

/**
 * The page's reason. Under the "Feedback not sent" / "Approval not sent"
 * toast after a refused Send, and, for the agent being gone, the notice the
 * page shows as soon as it hears it (before any Send).
 */
export const AGENT_GONE_REASON = "The agent that asked for this review is gone. Your comments are kept.";
export const AGENT_AWAY_REASON = "No agent session can receive this right now. Your comments are kept.";
export const NO_SESSION_REASON = "This review has no agent session to send to. Your comments are kept.";

/** The CLI's stderr line when it ends a review whose agent is gone and whose page was closed. */
export const AGENT_GONE_CLI_LINE = "Plannotator: the agent that asked for this review is gone, so the review ends. Its draft is kept.";

/** The Claude Code mod's log line for a review the CLI ended that way (`<subject>` is the review's subject). */
export const REVIEW_AGENT_GONE_MOD_LOG = (subject: string): string =>
  `The review of ${subject} ended while no Claude Code session was open for it. Your comments are saved as a draft; open a review of the same changes to get them back.`;
