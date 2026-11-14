/**
 * PR risk ranking in the Inbox (approval "code-review-launch-build", item 4):
 * what the window and the server share. The person's rules say what a high-risk
 * pull request is; an agent judges each new PR head against them.
 */

export type InboxPullRiskLevel = "low" | "medium" | "high";

export const INBOX_PULL_RISK_LEVELS: readonly InboxPullRiskLevel[] = ["low", "medium", "high"];


/** The longest sentence a judgment may carry. */
export const INBOX_PULL_RISK_WHY_MAX = 300;

export interface InboxPullRiskJudgment {
  level: InboxPullRiskLevel;
  /** One sentence: what in the diff decided it. Written by an agent that read untrusted text: shown as plain text only. */
  why: string;
  /**
   * A high judgment's places in the diff (context notes, approval "inbox-context-notes"): the lines that decided it,
   * the most important first, each inside one hunk of the diff that was judged. Only a high judgment has them; absent
   * on every other, and on a high one whose agent named none. Readers that do not know them show the judgment as before.
   */
  where?: InboxPullRiskPlace[];
}

/** The most places one judgment marks. */
export const INBOX_PULL_RISK_PLACES_MAX = 5;

/** One place a high-risk judgment marks in the diff it judged. Written by an agent that read untrusted text: plain text only. */
export interface InboxPullRiskPlace {
  /** The file's path as the diff names it. */
  file: string;
  /** `new` for added or unchanged lines, `old` for removed lines. */
  side: "new" | "old";
  /** First and last line, numbered as the hunk headers number that side. */
  lines: [number, number];
  /** The line of the person's rules these lines touch, word for word; absent when the agent named none that is. */
  rule?: string;
  /** One sentence: what these lines do that the rule describes. */
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
  /** The agent's model, or null for the agent's own default. */
  model: string | null;
  agents: InboxPullRiskAgent[];
  /** By pull request key, only for its current head and the current rules. */
  judgments: Record<string, InboxPullRiskJudgment>;
  /**
   * By pull request key, why it has no judgment at its current head: the agent or the forge refused or failed.
   * A failed one is never given a level. May hold what an agent wrote: shown as plain text only.
   */
  failed: Record<string, string>;
  /** Judgments queued or running now: the window reads again while there are any. */
  pending: number;
  /** Why the agent's last run failed (not signed in, refused the diff, an answer that made no sense), or null. */
  last_failure: string | null;
}

/** `GET /api/inbox/pulls/risk/models`: what the chosen agent offers, and the pick to start on. */
export interface InboxPullRiskModels {
  models: { id: string; label: string }[];
  /** The pick to start on, or null to start on the agent's own default (as the guided review does for Pi and OpenCode). */
  default_model: string | null;
}
