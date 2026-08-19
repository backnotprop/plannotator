import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  formatInteractiveNoArgClarification,
  formatSubcommandHelp,
  formatTopLevelHelp,
  formatVersion,
  hasHelpFlag,
  isInteractiveNoArgInvocation,
  isSubcommandHelpInvocation,
  isTopLevelHelpInvocation,
  isUninstallConfirmationAccepted,
  isVersionInvocation,
  parseStrictAnnotateOptions,
  parseUninstallOptions,
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
    expect(output).toContain("plannotator review [--git | --gitbutler] [--tailscale] [PR_URL]");
    expect(output).toContain("plannotator annotate <file.md | file.txt | file.html | https://... | folder/>");
    expect(output).toContain("[--markdown] [--no-jina]");
    expect(output).toContain("plannotator annotate-last [--stdin]");
    expect(output).toContain("plannotator copilot-last [--gate] [--json] [--hook]");
    expect(output).toContain("plannotator setup-goal <interview|facts>");
    expect(output).toContain("plannotator uninstall [--purge] [--yes]");
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
      "copilot-last",
      "setup-goal",
      "archive",
      "guide",
      "sessions",
      "uninstall",
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
    expect(formatSubcommandHelp("uninstall")).toContain(
      "Local plans, history, drafts",
    );
    expect(formatSubcommandHelp("uninstall")).toContain(
      "not stored on a Plannotator server",
    );
    // unknown key falls back to top-level help
    expect(formatSubcommandHelp("nope")).toBe(formatTopLevelHelp());
  });
});

describe("uninstall CLI options", () => {
  test("defaults to preserving data and requiring confirmation", () => {
    expect(parseUninstallOptions([])).toEqual({
      purge: false,
      yes: false,
      dryRun: false,
    });
  });

  test("parses purge, automation, and preview flags", () => {
    expect(
      parseUninstallOptions(["--dry-run", "--purge", "-y"]),
    ).toEqual({
      purge: true,
      yes: true,
      dryRun: true,
    });
  });

  test("rejects unknown and duplicate options", () => {
    expect(() => parseUninstallOptions(["--force"])).toThrow(
      "Unknown uninstall option",
    );
    expect(() => parseUninstallOptions(["--purge", "--purge"])).toThrow(
      "--purge may only be specified once",
    );
    expect(() => parseUninstallOptions(["--yes", "-y"])).toThrow(
      "--yes/-y may only be specified once",
    );
    expect(() => parseUninstallOptions(["--dry-run", "--dry-run"])).toThrow(
      "--dry-run may only be specified once",
    );
  });

  test("uses a stronger confirmation for purge", () => {
    expect(isUninstallConfirmationAccepted("yes", false)).toBe(true);
    expect(isUninstallConfirmationAccepted("Y", false)).toBe(true);
    expect(isUninstallConfirmationAccepted("", false)).toBe(false);
    expect(isUninstallConfirmationAccepted("yes", true)).toBe(false);
    expect(isUninstallConfirmationAccepted(" PURGE ", true)).toBe(true);
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
    expect(output).toContain("plannotator uninstall");
    expect(output).toContain("Run 'plannotator --help' for top-level usage.");
  });
});

describe("guide subcommand through the entrypoint", () => {
  // Guards the argv hand-off in apps/hook/server/index.ts: the entrypoint
  // strips the annotate gate flags (`--json` among them) from the whole argv
  // before dispatching, and `plannotator guide share --json` must still print
  // the JSON record the guide CLI owns rather than the bare URL.
  //
  // The entrypoint imports the built app HTML (`../dist/*.html`) at module
  // load, so it will not even start without those files, and the CI test job
  // does not run `bun run build:hook`. The guide subcommand never serves them,
  // so the test stands in placeholders for whichever one is missing and removes
  // exactly those again afterwards; a real build is left alone.
  test("guide share --json prints the JSON record, wherever --json sits", async () => {
    const { mkdirSync, mkdtempSync, rmSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { FIXTURE_V1_PR } = await import("@plannotator/shared/guide-format-fixtures");
    const workDir = mkdtempSync(join(tmpdir(), "plannotator-guide-entry-"));
    const distDir = resolve(import.meta.dir, "../dist");
    const stubbed = ["index.html", "review.html"].map((name) => join(distDir, name)).filter((path) => !existsSync(path));
    if (stubbed.length > 0) {
      mkdirSync(distDir, { recursive: true });
      for (const path of stubbed) writeFileSync(path, "<!doctype html><title>test stub</title>");
    }
    const host = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req) {
        const u = new URL(req.url);
        if (u.pathname === "/api/g" && req.method === "POST") {
          return Response.json({ id: "HostId0123456789abcdef", url: `${u.origin}/g/HostId0123456789abcdef`, deleteToken: "host-del-tok" }, { status: 201 });
        }
        return new Response("nope", { status: 404 });
      },
    });
    try {
      writeFileSync(join(workDir, "snap.json"), JSON.stringify(FIXTURE_V1_PR));
      const entry = resolve(import.meta.dir, "index.ts");
      const env = { ...process.env, PLANNOTATOR_DATA_DIR: join(workDir, "data"), PLANNOTATOR_GUIDE_SHARE_URL: `http://127.0.0.1:${host.port}` };
      delete env.PLANNOTATOR_SHARE;
      for (const argv of [
        ["guide", "share", "--snapshot", "snap.json", "--json"],
        ["guide", "share", "--json", "--snapshot", "snap.json"],
      ]) {
        const proc = Bun.spawn(["bun", "run", entry, ...argv], { cwd: workDir, env, stdout: "pipe", stderr: "pipe" });
        const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
        expect(code, stderr).toBe(0);
        const record = JSON.parse(stdout) as { id: string; url: string; deleteToken: string };
        expect(record.id).toBe("HostId0123456789abcdef");
        expect(record.deleteToken).toBe("host-del-tok");
        expect(record.url).toContain("#key=");
        expect(stderr).toContain("plannotator guide unshare HostId0123456789abcdef --token host-del-tok");
      }
    } finally {
      host.stop(true);
      rmSync(workDir, { recursive: true, force: true });
      for (const path of stubbed) rmSync(path, { force: true });
    }
  }, 30_000);
});
