import { describe, expect, test } from "bun:test";
import { allowedToolsOf, buildClaudeCommand, claudeRulesAdmit, detectClaudeShellBlocked, disallowedToolsOf } from "./claude-review";
import { buildAgentReviewUserMessage, getLocalDiffInstruction } from "./agent-review-message";
import type { DiffType } from "./vcs";
import type { PRMetadata } from "./pr";
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

  test("loads only user settings, so a checkout's own .claude/settings*.json cannot add rules or hooks", () => {
    expect(valueOf(build(), "--setting-sources")).toBe("user");
    expect(valueOf(build({ sandbox: false }), "--setting-sources")).toBe("user");
  });

  test("uses the same allow and deny lists as the review job", () => {
    const review = buildClaudeCommand("p").command;
    expect(allowedToolsOf(build())).toBe(allowedToolsOf(review));
    expect(disallowedToolsOf(build())).toBe(disallowedToolsOf(review));
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

// The job allowlist must admit every command the job prompts tell the model to
// run, or the job fails under dontAsk (the since-base prompt once asked for
// `git ls-files`, which no allowlist carried). Commands are read out of the
// real prompt text, so a new instruction that outgrows the allowlist fails.
describe("Claude job allowlist vs the commands the prompts instruct", () => {
  const command = buildClaudeCommand("p").command;
  const ALLOWED = allowedToolsOf(command);
  const DISALLOWED = disallowedToolsOf(command);
  const admitted = (cmd: string) => claudeRulesAdmit(cmd, ALLOWED, DISALLOWED);

  // Backticked git/jj commands in a prompt, with the prompt's placeholders
  // filled by literal values the model would substitute.
  const promptCommands = (text: string): string[] =>
    [...text.matchAll(/`((?:git|jj) [^`]+)`/g)]
      .map((m) => m[1].replace("<merge-base>", "8ce0d729").replace("<upstream>", "origin/main"));

  const diffTypes: DiffType[] = [
    "uncommitted", "staged", "unstaged", "last-commit", "branch", "merge-base",
    "since-base", "local-vs-remote", "all", "jj-current", "jj-last", "jj-line",
    "jj-evolog", "jj-all", "commit:8ce0d729aa11bb22cc33dd44ee55ff6677889900" as DiffType,
  ];

  test("every local diff instruction's commands are admitted", () => {
    const cmds = diffTypes.flatMap((t) => promptCommands(getLocalDiffInstruction(t, "main")?.inspect ?? ""));
    expect(cmds).toContain("git ls-files --others --exclude-standard");
    for (const cmd of cmds) expect([cmd, admitted(cmd)]).toEqual([cmd, true]);
  });

  test("PR-mode instructions and PR/issue context commands are admitted", () => {
    const pr = { url: "https://github.com/o/r/pull/7", baseBranch: "main" } as PRMetadata;
    const text = buildAgentReviewUserMessage("", "branch" as DiffType, { hasLocalAccess: true }, pr);
    const diffCmd = text.match(/git diff origin\/\S+/)?.[0];
    expect(diffCmd).toBeDefined();
    for (const cmd of [
      diffCmd!, "gh pr view https://github.com/o/r/pull/7", "gh pr diff 7",
      "gh issue view 123", "glab mr view 7", "glab mr diff 7", "glab issue view 12",
    ]) expect([cmd, admitted(cmd)]).toEqual([cmd, true]);
  });

  test("broad prefixes the prompts never use are not admitted", () => {
    for (const cmd of ["git -C api diff", "gh api repos/o/r/pulls/7", "glab api projects", "git branch topic", "git remote add up x"]) {
      expect([cmd, admitted(cmd)]).toEqual([cmd, false]);
    }
    // Deny rules win over an allowed prefix.
    expect(admitted("git diff --output=review.patch")).toBe(false);
    expect(admitted("git diff HEAD --output review.patch")).toBe(false);
  });

  test("a refused command that a deny rule covers never reads as a blocked shell", () => {
    const cmd = "git diff --output=review.patch";
    const stdout = [bashUse("a", cmd), toolResult("a", DENIED, true), result([denial("a", cmd)])].join("\n");
    expect(detectClaudeShellBlocked(stdout, ALLOWED, DISALLOWED)).toBe(false);
    // The same stdout for an allowed command is the blocked-shell signal.
    const plain = [bashUse("a", "git diff HEAD"), toolResult("a", DENIED, true), result([denial("a", "git diff HEAD")])].join("\n");
    expect(detectClaudeShellBlocked(plain, ALLOWED, DISALLOWED)).toBe(true);
  });
});
