import { describe, expect, test } from "bun:test";
import { allowedToolsOf, buildClaudeCommand, detectClaudeShellBlocked } from "./claude-review";
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
const result = (denials: Array<{ tool_name: string; tool_use_id: string; tool_input?: unknown }>) =>
  JSON.stringify({ type: "result", is_error: false, permission_denials: denials });

// The real allowlist a Code Tour job launches with, so the rule is tested
// against what the runner actually passes.
const TOUR_ALLOWED = allowedToolsOf(buildTourClaudeCommand("p").command);
const denial = (id: string, command: string) => ({ tool_name: "Bash", tool_use_id: id, tool_input: { command } });

describe("detectClaudeShellBlocked (#1627)", () => {
  test("warns for the reported shape: compound refused, then a plain allowlisted git command refused", () => {
    const compound = "MB=$(git merge-base origin/master HEAD) && echo $MB";
    const stdout = [
      bashUse("a", compound), toolResult("a", DENIED, true),
      bashUse("b", "git merge-base origin/master HEAD"), toolResult("b", DENIED, true),
      result([denial("a", compound), denial("b", "git merge-base origin/master HEAD")]),
    ].join("\n");
    expect(detectClaudeShellBlocked(stdout, TOUR_ALLOWED)).toBe(true);
  });

  test("a sandbox refusal answered only in a tool result counts too", () => {
    const stdout = [
      bashUse("a", "git status"), toolResult("a", "sandbox failed to start: bubblewrap (bwrap) not installed", true),
      result([]),
    ].join("\n");
    expect(detectClaudeShellBlocked(stdout, TOUR_ALLOWED)).toBe(true);
  });

  test("refusals of compound, variable-bearing, or non-allowlisted commands never count", () => {
    const cmds = ["git log --oneline | head", "git diff $MB", "git push origin HEAD", "echo hi", "npm test"];
    const stdout = [
      ...cmds.flatMap((c, i) => [bashUse(`c${i}`, c), toolResult(`c${i}`, DENIED, true)]),
      result(cmds.map((c, i) => denial(`c${i}`, c))),
    ].join("\n");
    expect(detectClaudeShellBlocked(stdout, TOUR_ALLOWED)).toBe(false);
  });

  test("does not warn once any Bash call succeeded", () => {
    const stdout = [
      bashUse("a", "git merge-base main HEAD"), toolResult("a", DENIED, true),
      bashUse("b", "git merge-base main HEAD"), toolResult("b", "8ce0d729", false),
      result([denial("a", "git merge-base main HEAD")]),
    ].join("\n");
    expect(detectClaudeShellBlocked(stdout, TOUR_ALLOWED)).toBe(false);
  });

  test("a command's own failure, no Bash, or no allowlist never warns", () => {
    const ownFailure = [bashUse("a", "git show nope"), toolResult("a", "fatal: bad object nope", true), result([])].join("\n");
    expect(detectClaudeShellBlocked(ownFailure, TOUR_ALLOWED)).toBe(false);
    expect(detectClaudeShellBlocked(result([]), TOUR_ALLOWED)).toBe(false);
    const refusedPlain = [bashUse("a", "git status"), toolResult("a", DENIED, true), result([denial("a", "git status")])].join("\n");
    expect(detectClaudeShellBlocked(refusedPlain, "")).toBe(false);
  });

  test("ignores refusals of non-Bash tools", () => {
    const stdout = result([{ tool_name: "mcp__idea__git_status", tool_use_id: "x", tool_input: { command: "git status" } }]);
    expect(detectClaudeShellBlocked(stdout, TOUR_ALLOWED)).toBe(false);
  });
});
