export type InboxPullRiskLevel = "low" | "medium" | "high";

export const INBOX_PULL_RISK_LEVELS: readonly InboxPullRiskLevel[] = ["low", "medium", "high"];


/** The longest sentence a judgment may carry. */
export const INBOX_PULL_RISK_WHY_MAX = 300;

export interface InboxPullRiskJudgment {
  level: InboxPullRiskLevel;
  why: string;
  where?: InboxPullRiskPlace[];
}

/** The most places one judgment marks. */
export const INBOX_PULL_RISK_PLACES_MAX = 5;

/** One place a high-risk judgment marks in the diff it judged. Written by an agent that read untrusted text: plain text only. */
export interface InboxPullRiskPlace {
  file: string;
  side: "new" | "old";
  lines: [number, number];
  rule?: string;
  why: string;
}

/** An agent CLI found on this computer that can be the risk agent. */
export interface InboxPullRiskAgent {
  id: string;
  label: string;
}

/** `GET /api/inbox/pulls/risk`: the person's settings, and the judgments of the PRs the last list showed. */
export interface InboxPullRiskAnswer {
  rules: string;
  provider: string | null;
  model: string | null;
  agents: InboxPullRiskAgent[];
  judgments: Record<string, InboxPullRiskJudgment>;
  /**
   * By pull request key, why it has no judgment at its current head: the agent or the forge refused or failed.
   * A failed one is never given a level. May hold what an agent wrote: shown as plain text only.
   */
  failed: Record<string, string>;
  pending: number;
  last_failure: string | null;
}

/** `GET /api/inbox/pulls/risk/models`: what the chosen agent offers, and the pick to start on. */
export interface InboxPullRiskModels {
  models: { id: string; label: string }[];
  default_model: string | null;
}
