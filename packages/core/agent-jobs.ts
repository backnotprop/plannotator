/**
 * Agent Jobs — shared types, state machine, and SSE helpers.
 *
 * Runtime-agnostic: no node:fs, no node:http, no Bun APIs.
 * Both the Bun server handler and (future) Node handler import
 * this module and wrap it with their respective HTTP transport layers.
 *
 * Mirrors packages/shared/external-annotation.ts in structure.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AgentJobStatus = "starting" | "running" | "done" | "failed" | "killed";

/**
 * Snapshot of the diff the reviewer was looking at when this job was launched.
 * Carried on the job so downstream UIs (agent-result panel "Copy All") export
 * the same `**Diff:** ...` header the job was actually run against — if the
 * reviewer switches the UI to a different diff afterwards, the job's snapshot
 * still reflects truth. Structurally compatible with the UI-side
 * `FeedbackDiffContext` in `packages/review-editor/utils/exportFeedback.ts`.
 */
export interface AgentJobDiffContext {
  mode: string;
  base?: string;
  worktreePath?: string | null;
  /** Human-readable label captured with provider-specific selectors. */
  label?: string;
  /** Exact server snapshot that supplied the reviewed line coordinates. */
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
  if (diffContext.mode.startsWith("commit:")) {
    const commitSha = diffContext.mode.slice("commit:".length);
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
  /** Unique job identifier (UUID). */
  id: string;
  /** Source identifier for external annotations — "agent-{id prefix}". */
  source: string;
  /** Provider that spawned this job — "claude", "codex", "tour", "shell", etc. */
  provider: string;
  /** Underlying engine used (e.g., "claude" or "codex"). Set when provider is "tour". */
  engine?: string;
  /** Model used (e.g., "sonnet", "opus"). Set when provider is "tour" with Claude engine. */
  model?: string;
  /** Claude --effort level (e.g., "low", "medium", "high", "xhigh", "max"). */
  effort?: string;
  /** Codex reasoning effort level (e.g., "high", "medium"). */
  reasoningEffort?: string;
  /** Whether Codex fast mode (service_tier=fast) was enabled. */
  fastMode?: boolean;
  /** Pi's unified reasoning level (marker engines only), e.g. "minimal", "high". */
  thinking?: string;
  /** Human-readable label for the job. */
  label: string;
  /** Current lifecycle status. */
  status: AgentJobStatus;
  /** Timestamp when the job was created. */
  startedAt: number;
  /** Timestamp when the job reached a terminal state. */
  endedAt?: number;
  /** Process exit code (set on done/failed). */
  exitCode?: number;
  /** Last ~500 chars of stderr on failure. */
  error?: string;
  /** The actual command that was spawned (for display/debug). */
  command: string[];
  /** Working directory where the process was spawned. */
  cwd?: string;
  /** The review prompt text (system + user message). Stored separately from command for providers that use stdin. */
  prompt?: string;
  /** Review summary set by the agent on completion. */
  summary?: {
    correctness: string;
    explanation: string;
    confidence: number;
  };
  /** PR URL at launch time — used to attribute findings to the correct PR. */
  prUrl?: string;
  /** PR diff scope at launch time — "layer" or "full-stack". */
  diffScope?: string;
  /** Diff context at launch time (see AgentJobDiffContext). */
  diffContext?: AgentJobDiffContext;
  /** Resolved review profile id at launch time (e.g. "builtin:default", "user:security"). */
  reviewProfileId?: string;
  /** Resolved review profile label — rides on findings so the UI can show a profile tag. */
  reviewProfileLabel?: string;
}

export interface AgentCapability {
  id: string;
  name: string;
  available: boolean;
  /**
   * Provider-discovered model catalog (currently only Cursor). Best-effort and
   * account-specific — populated from the provider CLI at capability-detection
   * time, empty when discovery fails or the CLI is unauthenticated. The UI
   * drives its model picker from this instead of a hardcoded list.
   */
  models?: { id: string; label: string }[];
}

export interface AgentCapabilities {
  mode: "plan" | "review" | "annotate";
  providers: AgentCapability[];
  /** True if at least one provider is available. */
  available: boolean;
}

// ---------------------------------------------------------------------------
// SSE event types
// ---------------------------------------------------------------------------

export type AgentJobEvent =
  | { type: "snapshot"; jobs: AgentJobInfo[] }
  | { type: "job:started"; job: AgentJobInfo }
  | { type: "job:updated"; job: AgentJobInfo }
  | { type: "job:completed"; job: AgentJobInfo }
  | { type: "job:log"; jobId: string; delta: string }
  | { type: "jobs:cleared" };

// ---------------------------------------------------------------------------
// SSE helpers
// ---------------------------------------------------------------------------

/** Heartbeat comment to keep SSE connections alive (sent every 30s). */
export const AGENT_HEARTBEAT_COMMENT = ":\n\n";

/** Interval in ms between heartbeat comments. */
export const AGENT_HEARTBEAT_INTERVAL_MS = 30_000;

/** Encode an event as an SSE `data:` line. */
export function serializeAgentSSEEvent(event: AgentJobEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Check if a status is terminal (no further transitions). */
export function isTerminalStatus(status: AgentJobStatus): boolean {
  return status === "done" || status === "failed" || status === "killed";
}

/** Generate the source identifier for a job from its ID. */
export function jobSource(id: string): string {
  return "agent-" + id.slice(0, 8);
}

// ---------------------------------------------------------------------------
// Review ingestion completion semantics
// ---------------------------------------------------------------------------

/** Calm, provider-neutral failure reason. Never leak schema/CLI internals. */
export const REVIEW_OUTPUT_FAILED = "Review finished but produced no usable findings.";

/** Flip a job to failed with a calm one-liner (Code Tour precedent). */
export function markJobReviewFailed(job: AgentJobInfo, error: string): void {
  job.status = "failed";
  job.error = error;
}
