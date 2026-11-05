/**
 * PR risk ranking in the Inbox (approval "code-review-launch-build", item 4):
 * what the window and the server share. The person's rules say what a high-risk
 * pull request is; a cheap agent judges each new PR head against them.
 */

export type InboxPullRiskLevel = "low" | "medium" | "high";

export const INBOX_PULL_RISK_LEVELS: readonly InboxPullRiskLevel[] = ["low", "medium", "high"];


/** The longest sentence a judgment may carry. */
export const INBOX_PULL_RISK_WHY_MAX = 300;

export interface InboxPullRiskJudgment {
  level: InboxPullRiskLevel;
  /** One sentence: what in the diff decided it. Written by an agent that read untrusted text: shown as plain text only. */
  why: string;
}

/** An agent CLI found on this computer that can be the risk agent. */
export interface InboxPullRiskAgent {
  /** The Ask AI provider's name (`claude-agent-sdk`, `codex-sdk`, `pi-sdk`, `opencode-sdk`). */
  id: string;
  label: string;
}

/** `GET /api/inbox/pulls/risk`: the person's settings, and the judgments of the PRs the last list showed. */
export interface InboxPullRiskAnswer {
  /** The person's own words; empty until they write some, and nothing runs while it is empty. */
  rules: string;
  /** The risk agent, or null until one is chosen. */
  provider: string | null;
  /** The agent's model, or null for the default pick. */
  model: string | null;
  agents: InboxPullRiskAgent[];
  /** By pull request key, only for its current head and the current rules. */
  judgments: Record<string, InboxPullRiskJudgment>;
  /** Judgments queued or running now: the window reads again while there are any. */
  pending: number;
  /** The last run of the agent itself failed (not signed in, an answer that made no sense). */
  agent_failed: boolean;
}

/** `GET /api/inbox/pulls/risk/models`: what the chosen agent offers, and the pick to start on. */
export interface InboxPullRiskModels {
  models: { id: string; label: string }[];
  /** The cheapest sensible model of the list, or null when it has none. */
  default_model: string | null;
}
