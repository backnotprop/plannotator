/**
 * Send never pretends: a code review decision is taken only when someone can
 * receive it.
 *
 * The agent that asked for a review (the process reading its decision, the
 * Claude Code session holding its launch, Pi's session) can quit while the
 * review is open. Nothing can then receive the decision, so Send must not
 * report success, archive it or delete the draft: the review server refuses
 * it and keeps everything. The host says what it knows (`agentPresence`,
 * apps/hook/server/review-agent-watch.ts for the CLI, Pi's own session for
 * Pi, OpenCode's command session); a server without the probe never refuses.
 *
 * - "gone": the agent quit for good. `410 agent_gone`.
 * - "away": no session can take it right now, but one may in a moment (Pi
 *   between sessions). `409 agent_away`; sending again may work.
 * - "no-session": the review was opened with no agent session to send to
 *   (OpenCode's in-process review with no session). `410 no_session`.
 *
 * A decision that goes to the PR platform is never refused: it was posted
 * there, and the page's status post (`platform: true`) only reports it.
 *
 * Shared by both review servers (packages/server/review.ts and the Pi copy).
 * The page reads the codes in packages/ui/utils/sendFailure.ts.
 */

import {
	AGENT_AWAY_CODE,
	AGENT_AWAY_REFUSAL_ERROR,
	AGENT_GONE_CODE,
	AGENT_GONE_REFUSAL_ERROR,
	NO_SESSION_CODE,
	NO_SESSION_REFUSAL_ERROR,
} from "./review-agent-gone-words";

export { AGENT_AWAY_CODE, AGENT_GONE_CODE, NO_SESSION_CODE };

export type AgentPresence = "here" | "gone" | "away" | "no-session";

export interface AgentRefusal {
	status: number;
	body: { error: string; code: string };
}

const REFUSALS: Record<Exclude<AgentPresence, "here">, AgentRefusal> = {
	gone: {
		status: 410,
		body: { error: AGENT_GONE_REFUSAL_ERROR, code: AGENT_GONE_CODE },
	},
	away: {
		status: 409,
		body: { error: AGENT_AWAY_REFUSAL_ERROR, code: AGENT_AWAY_CODE },
	},
	"no-session": {
		status: 410,
		body: { error: NO_SESSION_REFUSAL_ERROR, code: NO_SESSION_CODE },
	},
};

/**
 * What `/api/feedback` must answer instead of taking this decision, or null to
 * take it: a decision for the agent (not the platform path's status post)
 * while the host says nobody can receive it.
 */
export function agentRefusal(body: { platform?: unknown }, presence: (() => AgentPresence) | undefined): AgentRefusal | null {
	if (body.platform === true || !presence) return null;
	let answer: AgentPresence;
	try {
		answer = presence();
	} catch {
		// A probe that fails knows nothing: never refuse on it.
		return null;
	}
	if (answer === "here" || !(answer in REFUSALS)) return null;
	const refusal = REFUSALS[answer];
	return { status: refusal.status, body: { ...refusal.body } };
}
