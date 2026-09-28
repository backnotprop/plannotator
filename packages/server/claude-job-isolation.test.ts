import { describe, expect, test } from "bun:test";
import { buildClaudeCommand, detectClaudeShellBlocked } from "./claude-review";
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

  test("passes shell guidance as a non-empty value to --append-system-prompt", () => {
    const value = valueOf(build(), "--append-system-prompt");
    expect(value && !value.startsWith("--") ? value.trim().length : 0).toBeGreaterThan(0);
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

  test("sandbox: false leaves permission mode and tool lists untouched", () => {
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

// Stream-json lines as `claude -p --output-format stream-json` emits them.
const bashUse = (id: string, command: string) =>
  JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id, name: "Bash", input: { command } }] } });
const toolResult = (id: string, content: string, isError: boolean) =>
  JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content, is_error: isError }] } });
const DENIED = "Permission to use Bash has been denied because Claude Code is running in don't ask mode.";
const result = (denials: Array<{ tool_name: string; tool_use_id: string }>) =>
  JSON.stringify({ type: "result", is_error: false, permission_denials: denials });

describe("detectClaudeShellBlocked (#1627)", () => {
  test("warns for the reported shape: every Bash call refused", () => {
    const stdout = [
      bashUse("a", "MB=$(git merge-base origin/master HEAD) && echo $MB"),
      toolResult("a", DENIED, true),
      bashUse("b", "git merge-base origin/master HEAD"),
      toolResult("b", DENIED, true),
      result([{ tool_name: "Bash", tool_use_id: "a" }, { tool_name: "Bash", tool_use_id: "b" }]),
    ].join("\n");
    expect(detectClaudeShellBlocked(stdout)).toBe(true);
  });

  test("counts refusals from tool results when the result event lists none", () => {
    const stdout = [
      bashUse("a", "git status"), toolResult("a", "sandbox failed to start: bubblewrap (bwrap) not installed", true),
      bashUse("b", "git diff"), toolResult("b", DENIED, true),
      result([]),
    ].join("\n");
    expect(detectClaudeShellBlocked(stdout)).toBe(true);
  });

  test("does not warn once any Bash call succeeded", () => {
    const stdout = [
      bashUse("a", "MB=$(git merge-base main HEAD) && git log $MB"), toolResult("a", DENIED, true),
      bashUse("b", "git merge-base main HEAD"), toolResult("b", "8ce0d729", false),
      bashUse("c", "git log --oneline -1 8ce0d729 && echo"), toolResult("c", DENIED, true),
      result([{ tool_name: "Bash", tool_use_id: "a" }, { tool_name: "Bash", tool_use_id: "c" }]),
    ].join("\n");
    expect(detectClaudeShellBlocked(stdout)).toBe(false);
  });

  test("does not warn for a single refusal, a command's own failure, or no Bash at all", () => {
    const single = [bashUse("a", "git log | head"), toolResult("a", DENIED, true), result([{ tool_name: "Bash", tool_use_id: "a" }])].join("\n");
    expect(detectClaudeShellBlocked(single)).toBe(false);
    const ownFailures = [
      bashUse("a", "git show nope"), toolResult("a", "fatal: bad object nope", true),
      bashUse("b", "git show nope2"), toolResult("b", "fatal: bad object nope2", true),
      result([]),
    ].join("\n");
    expect(detectClaudeShellBlocked(ownFailures)).toBe(false);
    expect(detectClaudeShellBlocked(result([]))).toBe(false);
    expect(detectClaudeShellBlocked("")).toBe(false);
  });

  test("ignores refusals of non-Bash tools", () => {
    const stdout = result([{ tool_name: "mcp__idea__git_status", tool_use_id: "x" }, { tool_name: "WebFetch", tool_use_id: "y" }]);
    expect(detectClaudeShellBlocked(stdout)).toBe(false);
  });
});
