/**
 * A local code review whose agent is gone.
 *
 * The agent that asked for a review (the process reading its decision, or the
 * Claude Code session holding its launch) can quit while the review is open.
 * Nothing can then receive the decision, so Send must not report success,
 * archive it or delete the draft: the review server answers `410` with
 * `code: "agent_gone"` and keeps everything. The host decides what "gone"
 * means (`agentPresence`, apps/hook/server/review-agent-watch.ts for the CLI,
 * Pi's own session for Pi); a server without the probe never refuses.
 *
 * A decision that goes to the PR platform is never refused: it was posted
 * there, and the page's status post (`platform: true`) only reports it.
 *
 * Shared by both review servers (packages/server/review.ts and the Pi copy).
 */

/** The `code` on the review server's refusal; the review page reads it (packages/ui/utils/sendFailure.ts). */
export const AGENT_GONE_CODE = "agent_gone";

/** HTTP status of the refusal: the recipient is gone, the request may not be repeated to the same end. */
export const AGENT_GONE_STATUS = 410;

export type AgentPresence = "here" | "gone";

export function agentGoneBody(): { error: string; code: typeof AGENT_GONE_CODE } {
	return {
		error: "The agent that asked for this review is gone. Nothing was sent; your comments are kept.",
		code: AGENT_GONE_CODE,
	};
}

/**
 * Whether `/api/feedback` must refuse this decision: it is for the agent (not
 * the platform path's status post) and the host says the agent is gone.
 */
export function refusesDecisionForGoneAgent(
	body: { platform?: unknown },
	presence: (() => AgentPresence) | undefined,
): boolean {
	if (body.platform === true || !presence) return false;
	try {
		return presence() === "gone";
	} catch {
		// A probe that fails knows nothing: never refuse on it.
		return false;
	}
}
