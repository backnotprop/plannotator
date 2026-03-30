import { describe, test, expect } from "bun:test";
import { parseHookStdin, formatPreToolUseDeny } from "./hook-stdin";

describe("parseHookStdin", () => {
  test("extracts command from valid PreToolUse Bash input", () => {
    const input = JSON.stringify({
      session_id: "abc123",
      cwd: "/projects/test",
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: {
        command: "plannotator annotate docs/plan.md",
      },
    });
    const result = parseHookStdin(input);
    expect(result.command).toBe("plannotator annotate docs/plan.md");
    expect(result.cwd).toBe("/projects/test");
  });

  test("extracts command with flags and quoted paths", () => {
    const input = JSON.stringify({
      session_id: "x",
      cwd: "/home/user",
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: {
        command: 'plannotator review https://github.com/org/repo/pull/42',
      },
    });
    const result = parseHookStdin(input);
    expect(result.command).toBe("plannotator review https://github.com/org/repo/pull/42");
  });

  test("throws on invalid JSON", () => {
    expect(() => parseHookStdin("not json")).toThrow();
  });

  test("throws when tool_input.command is missing", () => {
    const input = JSON.stringify({
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: {},
    });
    expect(() => parseHookStdin(input)).toThrow("command");
  });
});

describe("formatPreToolUseDeny", () => {
  test("produces valid PreToolUse deny JSON", () => {
    const result = formatPreToolUseDeny("User feedback here");
    const parsed = JSON.parse(result);
    expect(parsed.hookSpecificOutput.hookEventName).toBe("PreToolUse");
    expect(parsed.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(parsed.hookSpecificOutput.permissionDecisionReason).toBe(
      "User feedback here"
    );
  });

  test("preserves multiline feedback with markdown verbatim", () => {
    const feedback =
      "## Issue 1\n> Remove this\n\n```ts\nold code\n```\n\n**Fix:** use new API";
    const result = formatPreToolUseDeny(feedback);
    const parsed = JSON.parse(result);
    expect(parsed.hookSpecificOutput.permissionDecisionReason).toBe(feedback);
  });
});
