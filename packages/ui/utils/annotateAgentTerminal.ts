import type { AgentTerminalAgent } from "@plannotator/core/agent-terminal";
import { storage } from "./storage";

const DEFAULT_AGENT_KEY = "plannotator-annotate-agent-terminal-default";
const SIDE_KEY = "plannotator-annotate-agent-terminal-side";

export type AnnotateAgentTerminalSide = "left" | "right";

export function getSavedAnnotateAgentId(): string | null {
  return storage.getItem(DEFAULT_AGENT_KEY);
}

export function saveAnnotateAgentId(agentId: string): void {
  storage.setItem(DEFAULT_AGENT_KEY, agentId);
}

export function getSavedAnnotateAgentTerminalSide(): AnnotateAgentTerminalSide {
  return resolveAnnotateAgentTerminalSide(storage.getItem(SIDE_KEY));
}

export function saveAnnotateAgentTerminalSide(side: AnnotateAgentTerminalSide): void {
  storage.setItem(SIDE_KEY, side);
}

export function resolveAnnotateAgentTerminalSide(value: unknown): AnnotateAgentTerminalSide {
  return value === "right" ? "right" : "left";
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
