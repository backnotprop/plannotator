export const AGENT_TERMINAL_WS_BASE_PATH = "/api/agent-terminal/pty";

export function buildAgentTerminalWsPath(token: string): string {
  if (!token || token.includes("/") || token.includes("?") || token.includes("#")) {
    throw new Error("Agent terminal WebSocket token must be a non-empty path segment.");
  }
  return `${AGENT_TERMINAL_WS_BASE_PATH}/${encodeURIComponent(token)}`;
}

export function isAgentTerminalWsRoute(pathname: string): boolean {
  return pathname === AGENT_TERMINAL_WS_BASE_PATH ||
    pathname.startsWith(`${AGENT_TERMINAL_WS_BASE_PATH}/`);
}

export type AgentTerminalDisabledReason =
  | "not-annotate-mode"
  | "remote-disabled"
  | "runtime-unavailable"
  | "webtui-unavailable"
  | "pty-unavailable"
  | "unsupported-runtime";

export type AgentTerminalAgent = {
  id: string;
  name: string;
  available: boolean;
};

export type AgentTerminalCapability =
  | {
      enabled: true;
      cwd: string;
      wsPath: string;
      agents: AgentTerminalAgent[];
    }
  | {
      enabled: false;
      reason: AgentTerminalDisabledReason;
      message?: string;
    };

export type AnnotateAgentTerminalMode =
  | "annotate"
  | "annotate-last"
  | "annotate-folder"
  | string
  | undefined;

export function supportsAnnotateAgentTerminalMode(
  mode: AnnotateAgentTerminalMode,
): boolean {
  return mode === "annotate" || mode === "annotate-folder";
}
