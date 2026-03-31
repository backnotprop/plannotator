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

export interface AgentJobInfo {
  /** Unique job identifier (UUID). */
  id: string;
  /** Source identifier for external annotations — "agent-{id prefix}". */
  source: string;
  /** Provider that spawned this job — "claude", "codex", "shell", etc. */
  provider: string;
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
}

export interface AgentCapability {
  id: string;
  name: string;
  available: boolean;
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
