import { describe, expect, test } from "bun:test";
import {
  formatInteractiveNoArgClarification,
  formatTopLevelHelp,
  formatVersion,
  isInteractiveNoArgInvocation,
  isReservedTopLevelCommand,
  isTopLevelHelpInvocation,
  isVersionInvocation,
  shouldAliasToAnnotate,
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
    expect(output).toContain("plannotator --version, -v");
    expect(output).toContain("plannotator [--browser <name>]");
    expect(output).toContain("plannotator review [--git] [PR_URL]");
    expect(output).toContain("plannotator annotate <file.md | file.txt | file.html | https://... | folder/>");
    expect(output).toContain("[--markdown] [--no-jina]");
    expect(output).toContain("plannotator annotate-last [--stdin]");
    expect(output).toContain("plannotator setup-goal <interview|facts>");
    expect(output).toContain("running 'plannotator' without arguments is for hook integration");
  });
});

describe("CLI --version", () => {
  test("recognizes --version and -v", () => {
    expect(isVersionInvocation(["--version"])).toBe(true);
    expect(isVersionInvocation(["-v"])).toBe(true);
    expect(isVersionInvocation([])).toBe(false);
    expect(isVersionInvocation(["review"])).toBe(false);
  });

  test("formats version string", () => {
    const output = formatVersion();
    expect(output).toStartWith("plannotator ");
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
    expect(output).toContain("plannotator setup-goal interview bundle.json --json");
    expect(output).toContain("plannotator sessions");
    expect(output).toContain("Run 'plannotator --help' for top-level usage.");
  });
});

describe("annotate target shorthand", () => {
  const annotatableTargets = new Set([
    "./",
    "docs/",
    "README.md",
    "page.html",
    "https://example.com",
  ]);
  const isAnnotatableTarget = (arg: string) => annotatableTargets.has(arg);
  const applyAlias = (args: string[]) =>
    shouldAliasToAnnotate(args, isAnnotatableTarget) ? ["annotate", ...args] : args;

  test("routes bare annotatable targets to annotate", () => {
    expect(applyAlias(["./"])).toEqual(["annotate", "./"]);
    expect(applyAlias(["docs/"])).toEqual(["annotate", "docs/"]);
    expect(applyAlias(["README.md"])).toEqual(["annotate", "README.md"]);
    expect(applyAlias(["https://example.com"])).toEqual(["annotate", "https://example.com"]);
  });

  test("preserves trailing flags when aliasing", () => {
    expect(applyAlias(["page.html", "--markdown"])).toEqual([
      "annotate",
      "page.html",
      "--markdown",
    ]);
  });

  test("keeps existing commands and bare invocation unchanged", () => {
    expect(shouldAliasToAnnotate([], isAnnotatableTarget)).toBe(false);
    expect(shouldAliasToAnnotate(["review"], () => true)).toBe(false);
    expect(shouldAliasToAnnotate(["annotate"], () => true)).toBe(false);
    expect(shouldAliasToAnnotate(["annotate-last"], () => true)).toBe(false);
    expect(shouldAliasToAnnotate(["archive"], () => true)).toBe(false);
    expect(shouldAliasToAnnotate(["sessions"], () => true)).toBe(false);
    expect(shouldAliasToAnnotate(["setup-goal"], () => true)).toBe(false);
    expect(shouldAliasToAnnotate(["improve-context"], () => true)).toBe(false);
    expect(shouldAliasToAnnotate(["install-runtime"], () => true)).toBe(false);
  });

  test("keeps internal bridge command families unchanged", () => {
    expect(isReservedTopLevelCommand("opencode-plan")).toBe(true);
    expect(isReservedTopLevelCommand("opencode-anything")).toBe(true);
    expect(isReservedTopLevelCommand("copilot-plan")).toBe(true);
    expect(isReservedTopLevelCommand("copilot-anything")).toBe(true);
    expect(shouldAliasToAnnotate(["opencode-plan"], () => true)).toBe(false);
    expect(shouldAliasToAnnotate(["copilot-plan"], () => true)).toBe(false);
  });

  test("does not alias typo commands or targets hidden behind unknown flags", () => {
    expect(shouldAliasToAnnotate(["revieew"], isAnnotatableTarget)).toBe(false);
    expect(shouldAliasToAnnotate(["--unknown", "README.md"], isAnnotatableTarget)).toBe(false);
  });
});
