export type AgentJobStatus = "starting" | "running" | "done" | "failed" | "killed";

/** Snapshot of the diff the reviewer was looking at when this job was launched. */
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

/** Stamp completed review findings with the diff snapshot the agent reviewed. */
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
  /** Resolved review profile id at launch time (e.g. "builtin:default", "user:security"). */
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

/** Heartbeat comment to keep SSE connections alive (sent every 30s). */
export const AGENT_HEARTBEAT_COMMENT = ":\n\n";

/** Interval in ms between heartbeat comments. */
export const AGENT_HEARTBEAT_INTERVAL_MS = 30_000;

/** Encode an event as an SSE `data:` line. */
export function serializeAgentSSEEvent(event: AgentJobEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

/** Check if a status is terminal (no further transitions). */
export function isTerminalStatus(status: AgentJobStatus): boolean {
  return status === "done" || status === "failed" || status === "killed";
}

/** Generate the source identifier for a job from its ID. */
export function jobSource(id: string): string {
  return "agent-" + id.slice(0, 8);
}

/** Calm, provider-neutral failure reason. Never leak schema/CLI internals. */
export const REVIEW_OUTPUT_FAILED = "Review finished but produced no usable findings.";

/** Flip a job to failed with a calm one-liner (Code Tour precedent). */
export function markJobReviewFailed(job: AgentJobInfo, error: string): void {
  job.status = "failed";
  job.error = error;
}
