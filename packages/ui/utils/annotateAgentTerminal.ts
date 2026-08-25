import type {
  AgentTerminalAgent,
  AnnotateAgentTerminalSide,
} from "@plannotator/core/agent-terminal";
import { configStore } from "../config";

// The side/placement vocabulary lives in @plannotator/core so the settings
// registry can reach it without importing this module (which would close a
// cycle through ConfigStore). Re-exported here because this is the seam the
// editor package imports from.
export {
  ANNOTATE_AGENT_TERMINAL_SIDES,
  isAnnotateAgentTerminalSide,
  resolveAnnotateAgentTerminalPlacement,
  resolveAnnotateAgentTerminalSide,
} from "@plannotator/core/agent-terminal";
export type {
  AnnotateAgentTerminalPlacement,
  AnnotateAgentTerminalSide,
} from "@plannotator/core/agent-terminal";

/**
 * Both Agent TUI preferences resolve through ConfigStore (server config file >
 * cookie > default) rather than reading cookies directly. Annotate sessions run
 * on a fresh random port every time, so a cookie is scoped to a single session;
 * the server round-trip through ~/.plannotator/config.json is what makes these
 * choices durable. Same seam identity.ts uses for `displayName`.
 */
export function getSavedAnnotateAgentId(): string | null {
  return configStore.get("agentTerminalDefaultAgent") || null;
}

export function saveAnnotateAgentId(agentId: string): void {
  configStore.set("agentTerminalDefaultAgent", agentId);
}

export function getSavedAnnotateAgentTerminalSide(): AnnotateAgentTerminalSide {
  return configStore.get("agentTerminalSide");
}

export function saveAnnotateAgentTerminalSide(side: AnnotateAgentTerminalSide): void {
  configStore.set("agentTerminalSide", side);
}

export function resolveAnnotateAgentId(
  agents: AgentTerminalAgent[],
  savedAgentId: string | null,
): string {
  const availableAgents = agents.filter((agent) => agent.available);
  if (savedAgentId && availableAgents.some((agent) => agent.id === savedAgentId)) {
    return savedAgentId;
  }
  return availableAgents[0]?.id ?? "";
}

export function resolveAgentTerminalWebSocketUrl(path: string): string {
  const url = new URL(path, window.location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}
