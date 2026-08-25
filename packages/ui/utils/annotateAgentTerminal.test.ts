import { describe, expect, test } from "bun:test";
import type { AgentTerminalAgent } from "@plannotator/core/agent-terminal";
import {
  resolveAnnotateAgentId,
  resolveAnnotateAgentTerminalPlacement,
  resolveAnnotateAgentTerminalSide,
} from "./annotateAgentTerminal";

const agents: AgentTerminalAgent[] = [
  { id: "claude", name: "Claude", available: true },
  { id: "opencode", name: "OpenCode", available: false },
  { id: "codex", name: "Codex", available: true },
];

describe("resolveAnnotateAgentId", () => {
  test("keeps a saved available agent", () => {
    expect(resolveAnnotateAgentId(agents, "codex")).toBe("codex");
  });

  test("skips a saved unavailable agent", () => {
    expect(resolveAnnotateAgentId(agents, "opencode")).toBe("claude");
  });

  test("returns empty when no agents are available", () => {
    expect(
      resolveAnnotateAgentId(
        agents.map((agent) => ({ ...agent, available: false })),
        "claude",
      ),
    ).toBe("");
  });
});

describe("resolveAnnotateAgentTerminalSide", () => {
  test("keeps the saved right-side preference", () => {
    expect(resolveAnnotateAgentTerminalSide("right")).toBe("right");
  });

  test("keeps the saved hidden preference", () => {
    expect(resolveAnnotateAgentTerminalSide("hidden")).toBe("hidden");
  });

  test("defaults missing and invalid preferences to the existing left side", () => {
    expect(resolveAnnotateAgentTerminalSide(null)).toBe("left");
    expect(resolveAnnotateAgentTerminalSide("bottom")).toBe("left");
  });
});

describe("resolveAnnotateAgentTerminalPlacement", () => {
  test("maps each side to the edge the panel docks against", () => {
    expect(resolveAnnotateAgentTerminalPlacement("left")).toBe("left");
    expect(resolveAnnotateAgentTerminalPlacement("right")).toBe("right");
  });

  test("hidden owns no edge, so an explicit session open docks left", () => {
    // Hidden is a preference about the default layout, not a lock: the rail
    // toggle and Shift Shift still open the panel, and it needs somewhere to go.
    expect(resolveAnnotateAgentTerminalPlacement("hidden")).toBe("left");
  });
});
