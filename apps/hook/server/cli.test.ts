import { describe, expect, test } from "bun:test";
import {
  formatInteractiveNoArgClarification,
  formatSubcommandHelp,
  formatTopLevelHelp,
  formatVersion,
  hasHelpFlag,
  isInteractiveNoArgInvocation,
  isSubcommandHelpInvocation,
  isTopLevelHelpInvocation,
  isVersionInvocation,
  parseStrictAnnotateOptions,
} from "./cli";

describe("CLI top-level help", () => {
  test("recognizes top-level --help", () => {
    expect(isTopLevelHelpInvocation(["--help"])).toBe(true);
    expect(isTopLevelHelpInvocation(["-h"])).toBe(true);
    expect(isTopLevelHelpInvocation([])).toBe(false);
    expect(isTopLevelHelpInvocation(["review", "--help"])).toBe(false);
  });

  test("renders concise top-level usage", () => {
    const output = formatTopLevelHelp();

    expect(output).toContain("plannotator --help");
    expect(output).toContain("plannotator --version, -v");
    expect(output).toContain("plannotator [--browser <name>]");
    expect(output).toContain("plannotator review [--git | --gitbutler] [PR_URL]");
    expect(output).toContain("plannotator annotate <file.md | file.txt | file.html | https://... | folder/>");
    expect(output).toContain("[--markdown] [--no-jina]");
    expect(output).toContain("plannotator annotate-last [--stdin]");
    expect(output).toContain("plannotator setup-goal <interview|facts>");
    expect(output).toContain("Run 'plannotator <command> --help' for command-specific usage.");
    expect(output).toContain("running 'plannotator' without arguments is for hook integration");
  });
});

describe("CLI subcommand help", () => {
  test("hasHelpFlag detects --help / -h anywhere", () => {
    expect(hasHelpFlag(["--help"])).toBe(true);
    expect(hasHelpFlag(["-h"])).toBe(true);
    expect(hasHelpFlag(["file.md", "--help"])).toBe(true);
    expect(hasHelpFlag(["--git"])).toBe(false);
    expect(hasHelpFlag([])).toBe(false);
  });

  test("recognizes `review --help` as a subcommand help invocation", () => {
    expect(isSubcommandHelpInvocation(["review", "--help"])).toBe("review");
    expect(isSubcommandHelpInvocation(["review", "-h"])).toBe("review");
    // help flag may appear after other args (agents probe in various ways)
    expect(isSubcommandHelpInvocation(["annotate", "file.md", "--help"])).toBe(
      "annotate",
    );
  });

  test("does not treat a real review invocation as help", () => {
    expect(isSubcommandHelpInvocation(["review"])).toBeNull();
    expect(isSubcommandHelpInvocation(["review", "--git"])).toBeNull();
    expect(isSubcommandHelpInvocation(["review", "--gitbutler"])).toBeNull();
    expect(
      isSubcommandHelpInvocation([
        "review",
        "https://github.com/owner/repo/pull/1",
      ]),
    ).toBeNull();
  });

  test("resolves the `last` alias to annotate-last help", () => {
    expect(isSubcommandHelpInvocation(["last", "--help"])).toBe("annotate-last");
    expect(isSubcommandHelpInvocation(["annotate-last", "--help"])).toBe(
      "annotate-last",
    );
  });

  test("covers every command advertised in top-level help", () => {
    // Each command listed in formatTopLevelHelp() must respond to --help so the
    // advertised "run 'plannotator <command> --help'" contract holds.
    for (const sub of [
      "annotate",
      "setup-goal",
      "archive",
      "sessions",
      "improve-context",
    ]) {
      expect(isSubcommandHelpInvocation([sub, "--help"])).toBe(sub);
    }
  });

  test("ignores help flags for unknown / internal subcommands", () => {
    expect(isSubcommandHelpInvocation(["opencode-review", "--help"])).toBeNull();
    expect(isSubcommandHelpInvocation(["install-runtime", "--help"])).toBeNull();
    expect(isSubcommandHelpInvocation(["--help"])).toBeNull();
    expect(isSubcommandHelpInvocation([])).toBeNull();
  });

  test("renders subcommand-specific usage", () => {
    expect(formatSubcommandHelp("review")).toContain(
      "plannotator review [--git | --gitbutler]",
    );
    expect(formatSubcommandHelp("review")).toContain("--gitbutler");
    expect(formatSubcommandHelp("review")).toContain("PR_URL");
    expect(formatSubcommandHelp("annotate")).toContain("--no-jina");
    expect(formatSubcommandHelp("annotate")).toContain("--require-approval");
    expect(formatSubcommandHelp("annotate")).toContain("--result-file <path>");
    expect(formatSubcommandHelp("annotate-last")).not.toContain(
      "--require-approval",
    );
    expect(formatSubcommandHelp("sessions")).toContain("--open [N]");
    // unknown key falls back to top-level help
    expect(formatSubcommandHelp("nope")).toBe(formatTopLevelHelp());
  });
});

describe("strict annotate CLI options", () => {
  test("extracts strict options before or after the target path", () => {
    const strictOrderings = [
      ["plan.md", "--require-approval", "--result-file", "result.json"],
      ["plan.md", "--result-file", "result.json", "--require-approval"],
      ["--require-approval", "plan.md", "--result-file", "result.json"],
      ["--require-approval", "--result-file", "result.json", "plan.md"],
      ["--result-file", "result.json", "plan.md", "--require-approval"],
      ["--result-file", "result.json", "--require-approval", "plan.md"],
    ];

    for (const ordering of strictOrderings) {
      expect(
        parseStrictAnnotateOptions([
          "annotate",
          ...ordering,
          "--gate",
          "--json",
        ]),
      ).toEqual({
        requireApproval: true,
        resultFile: "result.json",
        remainingArgs: ["annotate", "plan.md", "--gate", "--json"],
      });
    }
  });

  test("allows either strict option independently", () => {
    expect(
      parseStrictAnnotateOptions([
        "annotate",
        "plan.md",
        "--gate",
        "--json",
        "--require-approval",
      ]),
    ).toEqual({
      requireApproval: true,
      remainingArgs: ["annotate", "plan.md", "--gate", "--json"],
    });
    expect(
      parseStrictAnnotateOptions([
        "annotate",
        "--result-file",
        "result.json",
        "plan.md",
        "--gate",
        "--json",
      ]),
    ).toEqual({
      requireApproval: false,
      resultFile: "result.json",
      remainingArgs: ["annotate", "plan.md", "--gate", "--json"],
    });
  });

  test("leaves ordinary direct arguments unchanged", () => {
    const args = [
      "annotate",
      "plan.md",
      "--gate",
      "--json",
      "--markdown",
    ];
    expect(parseStrictAnnotateOptions(args)).toEqual({
      requireApproval: false,
      remainingArgs: args,
    });
  });

  test("requires annotate --gate --json without --hook", () => {
    for (const args of [
      ["review", "--gate", "--json", "--require-approval"],
      ["annotate-last", "--gate", "--json", "--require-approval"],
      ["annotate", "plan.md", "--json", "--require-approval"],
      ["annotate", "plan.md", "--gate", "--require-approval"],
      [
        "annotate",
        "plan.md",
        "--gate",
        "--json",
        "--hook",
        "--require-approval",
      ],
    ]) {
      expect(() => parseStrictAnnotateOptions(args)).toThrow();
    }
  });

  test("rejects missing and duplicate strict option values", () => {
    expect(() =>
      parseStrictAnnotateOptions([
        "annotate",
        "plan.md",
        "--gate",
        "--json",
        "--result-file",
      ]),
    ).toThrow("Missing value for --result-file");
    expect(() =>
      parseStrictAnnotateOptions([
        "annotate",
        "plan.md",
        "--gate",
        "--json",
        "--result-file",
        "first.json",
        "--result-file",
        "second.json",
      ]),
    ).toThrow("--result-file may only be specified once");
    expect(() =>
      parseStrictAnnotateOptions([
        "annotate",
        "plan.md",
        "--gate",
        "--json",
        "--require-approval",
        "--require-approval",
      ]),
    ).toThrow("--require-approval may only be specified once");
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
