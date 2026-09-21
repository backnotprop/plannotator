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

/**
 * The user's durable placement preference for the annotate-mode Agent TUI:
 * which edge it docks against, or `hidden` to keep it out of the layout.
 *
 * `hidden` is a preference, not a lock — the rail toggle, the Shift Shift
 * shortcut and Settings all still open the panel for the current session.
 * It only decides that nothing is docked until the user asks for it.
 */
export type AnnotateAgentTerminalSide = "left" | "right" | "hidden";

/**
 * The edge the panel actually docks against once it is on screen. `hidden`
 * owns no slot, so it is not a placement — see
 * `resolveAnnotateAgentTerminalPlacement`.
 */
export type AnnotateAgentTerminalPlacement = "left" | "right";

/** Every selectable side, in the order the Position control presents them. */
export const ANNOTATE_AGENT_TERMINAL_SIDES = [
  "left",
  "right",
  "hidden",
] as const satisfies readonly AnnotateAgentTerminalSide[];

export function isAnnotateAgentTerminalSide(
  value: unknown,
): value is AnnotateAgentTerminalSide {
  return value === "left" || value === "right" || value === "hidden";
}

/**
 * Coerce a stored or server-supplied value to a side. Anything unrecognized
 * (including an older release's value, or a hand-edited config.json) falls
 * back to `left`, which is where the panel docked before it was configurable.
 */
export function resolveAnnotateAgentTerminalSide(
  value: unknown,
): AnnotateAgentTerminalSide {
  return isAnnotateAgentTerminalSide(value) ? value : "left";
}

/**
 * Which edge to dock against when the panel is on screen. A `hidden`
 * preference has no edge of its own, so an explicit session open lands on the
 * historic left placement rather than nowhere.
 */
export function resolveAnnotateAgentTerminalPlacement(
  side: AnnotateAgentTerminalSide,
): AnnotateAgentTerminalPlacement {
  return side === "right" ? "right" : "left";
}
