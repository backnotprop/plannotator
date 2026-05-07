import { describe, expect, test } from "bun:test";
import {
  formatInteractiveNoArgClarification,
  formatTopLevelHelp,
  isInteractiveNoArgInvocation,
  isTopLevelHelpInvocation,
} from "./cli";

describe("CLI top-level help", () => {
  test("recognizes top-level --help", () => {
    expect(isTopLevelHelpInvocation(["--help"])).toBe(true);
    expect(isTopLevelHelpInvocation([])).toBe(false);
    expect(isTopLevelHelpInvocation(["review", "--help"])).toBe(false);
  });

  test("renders concise top-level usage", () => {
    const output = formatTopLevelHelp();

    expect(output).toContain("plannotator --help");
    expect(output).toContain("plannotator [--browser <name>]");
    expect(output).toContain("plannotator review [--git] [PR_URL]");
    expect(output).toContain("plannotator annotate <file.md | file.html | https://... | folder/>");
    expect(output).toContain("running 'plannotator' without arguments is for hook integration");
  });
});

describe("interactive no-arg invocation", () => {
  test("detects bare interactive invocation only when stdin is a TTY", () => {
    expect(isInteractiveNoArgInvocation([], true)).toBe(true);
    expect(isInteractiveNoArgInvocation([], false)).toBe(false);
    expect(isInteractiveNoArgInvocation([], undefined)).toBe(false);
    expect(isInteractiveNoArgInvocation(["review"], true)).toBe(false);
  });

  test("renders clarification for interactive users", () => {
    const output = formatInteractiveNoArgClarification();

    expect(output).toContain("usually launched automatically by Claude Code hooks");
    expect(output).toContain("It expects hook JSON on stdin.");
    expect(output).toContain("plannotator review");
    expect(output).toContain("plannotator sessions");
    expect(output).toContain("Run 'plannotator --help' for top-level usage.");
  });
});
