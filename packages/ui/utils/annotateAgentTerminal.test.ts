import { describe, expect, test } from "bun:test";
import type { AgentTerminalAgent } from "@plannotator/core/agent-terminal";
import { resolveAnnotateAgentId } from "./annotateAgentTerminal";

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
