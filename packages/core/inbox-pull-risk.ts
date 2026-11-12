export type InboxPullRiskLevel = "low" | "medium" | "high";

export const INBOX_PULL_RISK_LEVELS: readonly InboxPullRiskLevel[] = ["low", "medium", "high"];

export const INBOX_PULL_RISK_WHY_MAX = 300;

export interface InboxPullRiskJudgment {
  level: InboxPullRiskLevel;
  why: string;
  where?: InboxPullRiskPlace[];
}

export const INBOX_PULL_RISK_PLACES_MAX = 5;

export interface InboxPullRiskPlace {
  file: string;
  side: "new" | "old";
  lines: [number, number];
  rule?: string;
  why: string;
}

export interface InboxPullRiskAgent {
  id: string;
  label: string;
}

export interface InboxPullRiskAnswer {
  rules: string;
  provider: string | null;
  model: string | null;
  agents: InboxPullRiskAgent[];
  judgments: Record<string, InboxPullRiskJudgment>;
  failed: Record<string, string>;
  pending: number;
  last_failure: string | null;
}

export interface InboxPullRiskModels {
  models: { id: string; label: string }[];
  default_model: string | null;
}
