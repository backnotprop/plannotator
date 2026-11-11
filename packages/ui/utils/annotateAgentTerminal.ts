import type {
  AgentTerminalAgent,
  AnnotateAgentTerminalSide,
} from "@plannotator/core/agent-terminal";
import { configStore } from "../config";

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
 * Both Agent TUI preferences resolve through ConfigStore (server config file > cookie > default)
 * rather than reading cookies directly.
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
