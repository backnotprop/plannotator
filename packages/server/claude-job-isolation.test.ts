import { describe, expect, test } from "bun:test";
import { buildClaudeCommand, CLAUDE_JOB_SHELL_GUIDANCE } from "./claude-review";
import { buildTourClaudeCommand } from "./tour/tour-review";
import { buildGuideClaudeCommand } from "./guide/guide-review";
import type { ClaudeJobCommandOptions } from "./claude-review";

// #1627: every Claude Code agent job (review, Code Tour, Guided Review) must
// load no user MCP servers, and must be able to run with Claude Code's sandbox
// off where it cannot start — without ever widening its read-only posture.
const builders: Array<[string, (opts?: ClaudeJobCommandOptions) => string[]]> = [
  ["buildClaudeCommand", (opts) => buildClaudeCommand("p", "opus", undefined, opts).command],
  ["buildTourClaudeCommand", (opts) => buildTourClaudeCommand("p", "sonnet", undefined, opts).command],
  ["buildGuideClaudeCommand", (opts) => buildGuideClaudeCommand("p", "sonnet", undefined, opts).command],
];

function valueOf(command: string[], flag: string): string | undefined {
  const i = command.indexOf(flag);
  return i === -1 ? undefined : command[i + 1];
}

describe.each(builders)("%s job isolation (#1627)", (_name, build) => {
  test("passes --strict-mcp-config with no --mcp-config, so no MCP servers load", () => {
    const command = build();
    expect(command).toContain("--strict-mcp-config");
    expect(command).not.toContain("--mcp-config");
  });

  test("tells the model to run single commands, as one argv element", () => {
    expect(valueOf(build(), "--append-system-prompt")).toBe(CLAUDE_JOB_SHELL_GUIDANCE);
  });

  test("defers to the user's sandbox setting unless sandbox is explicitly false", () => {
    expect(build()).not.toContain("--settings");
    expect(build({ sandbox: true })).not.toContain("--settings");
  });

  test("sandbox: false turns Claude Code's sandbox off via --settings JSON", () => {
    const settings = valueOf(build({ sandbox: false }), "--settings");
    expect(settings).toBeDefined();
    expect(JSON.parse(settings!)).toEqual({ sandbox: { enabled: false } });
  });

  test("sandbox: false never widens permissions or the tool set", () => {
    const off = build({ sandbox: false });
    const on = build();
    expect(valueOf(off, "--permission-mode")).toBe("dontAsk");
    expect(off).not.toContain("--dangerously-skip-permissions");
    for (const flag of ["--tools", "--allowedTools", "--disallowedTools"]) {
      expect(valueOf(off, flag)).toBe(valueOf(on, flag));
    }
    expect(valueOf(off, "--disallowedTools")).toContain("Write");
    expect(valueOf(off, "--disallowedTools")).toContain("Edit");
  });
});
