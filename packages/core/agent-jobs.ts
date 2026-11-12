export type AgentJobStatus = "starting" | "running" | "done" | "failed" | "killed";

export interface AgentJobDiffContext {
  mode: string;
  base?: string;
  worktreePath?: string | null;
  label?: string;
  snapshotId?: string;
}

export interface AgentJobAnnotationContext {
  commitSha?: string;
  gitButlerDiffType?: string;
  gitButlerDiffLabel?: string;
  gitButlerBase?: string;
  gitButlerSnapshotId?: string;
}

export function getAgentJobAnnotationContext(
  diffContext?: AgentJobDiffContext,
): AgentJobAnnotationContext {
  if (!diffContext) return {};
  const commitPrefix = ["commit:", "jj-commit:"].find((prefix) => diffContext.mode.startsWith(prefix));
  if (commitPrefix) {
    const commitSha = diffContext.mode.slice(commitPrefix.length);
    return commitSha ? { commitSha } : {};
  }
  if (!diffContext.mode.startsWith("gitbutler:")) return {};
  return {
    gitButlerDiffType: diffContext.mode,
    ...(diffContext.label ? { gitButlerDiffLabel: diffContext.label } : {}),
    ...(diffContext.base ? { gitButlerBase: diffContext.base } : {}),
    ...(diffContext.snapshotId ? { gitButlerSnapshotId: diffContext.snapshotId } : {}),
  };
}

export interface AgentJobInfo {
  id: string;
  source: string;
  provider: string;
  engine?: string;
  model?: string;
  effort?: string;
  reasoningEffort?: string;
  fastMode?: boolean;
  thinking?: string;
  label: string;
  status: AgentJobStatus;
  startedAt: number;
  endedAt?: number;
  exitCode?: number;
  error?: string;
  warning?: string;
  command: string[];
  cwd?: string;
  prompt?: string;
  summary?: {
    correctness: string;
    explanation: string;
    confidence: number;
  };
  prUrl?: string;
  diffScope?: string;
  diffContext?: AgentJobDiffContext;
  reviewProfileId?: string;
  reviewProfileLabel?: string;
  guideContext?: {
    pr?: { url: string; headSha: string; label: string } | null;
    branchLabel?: string;
    headSha?: string;
  };
}

export interface AgentCapability {
  id: string;
  name: string;
  available: boolean;
  models?: { id: string; label: string }[];
}

export interface AgentCapabilities {
  mode: "plan" | "review" | "annotate";
  providers: AgentCapability[];
  available: boolean;
}

export type AgentJobEvent =
  | { type: "snapshot"; jobs: AgentJobInfo[] }
  | { type: "job:started"; job: AgentJobInfo }
  | { type: "job:updated"; job: AgentJobInfo }
  | { type: "job:completed"; job: AgentJobInfo }
  | { type: "job:log"; jobId: string; delta: string }
  | { type: "jobs:cleared" };

export const AGENT_HEARTBEAT_COMMENT = ":\n\n";

export const AGENT_HEARTBEAT_INTERVAL_MS = 30_000;

export function serializeAgentSSEEvent(event: AgentJobEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

export function isTerminalStatus(status: AgentJobStatus): boolean {
  return status === "done" || status === "failed" || status === "killed";
}

export function jobSource(id: string): string {
  return "agent-" + id.slice(0, 8);
}

export const REVIEW_OUTPUT_FAILED = "Review finished but produced no usable findings.";

export function markJobReviewFailed(job: AgentJobInfo, error: string): void {
  job.status = "failed";
  job.error = error;
}
