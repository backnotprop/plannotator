import { describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getJjSnapshotRevsets,
  resolveJjSnapshotEndpoint,
  getJjDiffArgs,
  getJjEvoLogEntries,
  jjLineBaseRevset,
  parseJjBookmarkList,
  parseJjRemoteBookmarkList,
  type ReviewJjRuntime,
  runJjDiff,
  selectDefaultJjCompareTarget,
} from "./jj-core";

describe("jj diff args", () => {
  test("maps Call flow modes to the revsets used by each visible Jujutsu diff", () => {
    // Parent hops are counted, never encoded as `@-` / `parents(@-)`: those
    // resolve to several revisions on a merge and `jj diff` rejects them.
    expect(getJjSnapshotRevsets("jj-current", "trunk()")).toEqual({
      from: { revset: "@", firstParentSteps: 1 },
      to: { revset: "@", firstParentSteps: 0 },
    });
    expect(getJjSnapshotRevsets("jj-last", "trunk()")).toEqual({
      from: { revset: "@", firstParentSteps: 2 },
      to: { revset: "@", firstParentSteps: 1 },
    });
    expect(getJjSnapshotRevsets("jj-line", "trunk()")).toEqual({
      from: { revset: "heads(::@ & ::(trunk()))", firstParentSteps: 0 },
      to: { revset: "@", firstParentSteps: 0 },
    });
    expect(getJjSnapshotRevsets("jj-evolog", "abc123456789")).toEqual({
      from: { revset: "abc123456789", firstParentSteps: 0 },
      to: { revset: "@", firstParentSteps: 0 },
    });
    expect(getJjSnapshotRevsets("jj-evolog", ""))
      .toBeNull();
    expect(getJjSnapshotRevsets("jj-all", "trunk()"))
      .toBeNull();
  });

  test("walks first parents so a merge revision resolves to one revision", async () => {
    const parentsOf: Record<string, string[]> = {
      "@": ["aaaaaaaaaaaa", "bbbbbbbbbbbb"],
      aaaaaaaaaaaa: ["cccccccccccc"],
      cccccccccccc: [],
    };
    const asked: string[] = [];
    const runtime = {
      async runJj(args: string[]) {
        const revision = args[args.indexOf("-r") + 1];
        asked.push(revision);
        return { stdout: (parentsOf[revision] ?? []).join("\n"), stderr: "", exitCode: 0 };
      },
    };

    // jj-current: one hop off the merge picks the FIRST parent, not both.
    expect(await resolveJjSnapshotEndpoint(runtime, { revset: "@", firstParentSteps: 1 }))
      .toBe("aaaaaaaaaaaa");
    // jj-last: two hops stay on the first-parent line.
    expect(await resolveJjSnapshotEndpoint(runtime, { revset: "@", firstParentSteps: 2 }))
      .toBe("cccccccccccc");
    expect(asked).toEqual(["@", "@", "aaaaaaaaaaaa"]);

    // A revision with no parent cannot be a snapshot base.
    expect(resolveJjSnapshotEndpoint(runtime, { revset: "cccccccccccc", firstParentSteps: 1 }))
      .rejects.toThrow();
  });

  test("uses a zero-hop revset verbatim without asking the repository", async () => {
    let calls = 0;
    const runtime = {
      async runJj() {
        calls += 1;
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    };
    expect(await resolveJjSnapshotEndpoint(runtime, { revset: "trunk()", firstParentSteps: 0 }))
      .toBe("trunk()");
    expect(calls).toBe(0);
  });

  test("builds git-format diff args for each jj mode", () => {
    expect(getJjDiffArgs("jj-current", "trunk()")).toEqual({
      args: ["diff", "--git", "-r", "@"],
      label: "Current change",
    });

    expect(getJjDiffArgs("jj-last", "trunk()")).toEqual({
      args: ["diff", "--git", "-r", "@-"],
      label: "Last change",
    });

    expect(getJjDiffArgs("jj-line", "trunk()")).toEqual({
      args: ["diff", "--git", "--from", "heads(::@ & ::(trunk()))", "--to", "@"],
      label: "Line of work vs trunk()",
    });

    expect(getJjDiffArgs("jj-all", "trunk()")).toEqual({
      args: ["diff", "--git", "--from", "root()", "--to", "@"],
      label: "All files",
    });
  });

  test("preserves hide-whitespace in every jj diff mode", () => {
    expect(getJjDiffArgs("jj-current", "trunk()", { hideWhitespace: true })?.args)
      .toEqual(["diff", "--git", "-w", "-r", "@"]);
    expect(getJjDiffArgs("jj-last", "trunk()", { hideWhitespace: true })?.args)
      .toEqual(["diff", "--git", "-w", "-r", "@-"]);
    expect(getJjDiffArgs("jj-line", "trunk()", { hideWhitespace: true })?.args)
      .toEqual(["diff", "--git", "-w", "--from", "heads(::@ & ::(trunk()))", "--to", "@"]);
    expect(getJjDiffArgs("jj-all", "trunk()", { hideWhitespace: true })?.args)
      .toEqual(["diff", "--git", "-w", "--from", "root()", "--to", "@"]);
  });

  test("drops hunk-less file chunks after hide-whitespace filtering", async () => {
    const runtimeForPatch = (stdout: string): ReviewJjRuntime => ({
      async runJj() {
        return {
          stdout,
          stderr: "",
          exitCode: 0,
        };
      },
    });

    const hunklessChunk = [
      "diff --git a/spacey.ts b/spacey.ts",
      "index 1111111..2222222 100644",
      "--- a/spacey.ts",
      "+++ b/spacey.ts",
      "",
    ].join("\n");
    const realChunk = [
      "diff --git a/real.ts b/real.ts",
      "index 3333333..4444444 100644",
      "--- a/real.ts",
      "+++ b/real.ts",
      "@@ -1 +1 @@",
      "-old",
      "+new",
      "",
    ].join("\n");

    const result = await runJjDiff(runtimeForPatch(hunklessChunk + realChunk), "jj-current", "trunk()", undefined, { hideWhitespace: true });

    expect(result.patch).not.toContain("spacey.ts");
    expect(result.patch).toContain("real.ts");
    expect(result.patch).toContain("@@ -1 +1 @@");

    const emptyResult = await runJjDiff(runtimeForPatch(hunklessChunk), "jj-current", "trunk()", undefined, { hideWhitespace: true });
    expect(emptyResult.patch).toBe("");
  });
});

describe("jj compare targets", () => {
  const testIfJj = (() => {
    try {
      return Bun.spawnSync(["jj", "--version"], { stdout: "pipe", stderr: "pipe" }).exitCode === 0;
    } catch {
      return false;
    }
  })()
    ? test
    : test.skip;

  testIfJj("uses the parent of the current mutable line of work", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "plannotator-jj-base-"));
    const immutableHeads = 'revset-aliases."immutable_heads()"=bookmarks(exact:"development")';
    const jj = (args: string[], configureImmutableHeads = false) => {
      const command = configureImmutableHeads ? ["jj", "--config", immutableHeads, ...args] : ["jj", ...args];
      const result = Bun.spawnSync(command, { cwd: workspace, stdout: "pipe", stderr: "pipe" });
      if (result.exitCode !== 0) throw new Error(result.stderr.toString());
      return result;
    };

    try {
      jj(["git", "init", "."]);
      writeFileSync(join(workspace, "history.txt"), "development\n");
      jj(["commit", "-m", "development"]);
      jj(["bookmark", "create", "development", "-r", "@-"]);

      jj(["new", "development"]);
      appendFileSync(join(workspace, "history.txt"), "feature one\n");
      jj(["commit", "-m", "feature one"]);
      appendFileSync(join(workspace, "history.txt"), "feature two\n");
      jj(["commit", "-m", "feature two"]);
      jj(["bookmark", "create", "feature", "-r", "@-"]);

      const runtime: ReviewJjRuntime = {
        async runJj(args, options) {
          const result = Bun.spawnSync(["jj", "--config", immutableHeads, ...args], {
            cwd: options?.cwd,
            stdout: "pipe",
            stderr: "pipe",
          });
          return {
            stdout: result.stdout.toString(),
            stderr: result.stderr.toString(),
            exitCode: result.exitCode,
          };
        },
      };

      // Verify the fixture's configured boundary independently of the code under test.
      expect(jj(["log", "--no-graph", "-r", "roots(reachable(@, mutable()))-", "-T", "bookmarks"], true).stdout.toString().trim())
        .toBe("development");
      await expect(selectDefaultJjCompareTarget(runtime, workspace)).resolves.toBe("development");
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test("resolves the line base in one JJ query and prefers its remote bookmark", async () => {
    const calls: string[][] = [];
    const runtime: ReviewJjRuntime = {
      async runJj(args) {
        calls.push(args);
        return {
          stdout: '[{"name":"development"},{"name":"development","remote":"origin"}]\\t0123456789abcdef\\n',
          stderr: "",
          exitCode: 0,
        };
      },
    };

    await expect(selectDefaultJjCompareTarget(runtime, "/repo")).resolves.toBe("development@origin");
    expect(calls).toEqual([[
      "log",
      "--no-graph",
      "-r",
      "fork_point(roots(reachable(@, mutable()))-)",
      "-T",
      'json(bookmarks) ++ "\\t" ++ commit_id ++ "\\n"',
    ]]);
  });

  test("uses the base commit id when it has no bookmark", async () => {
    const runtime: ReviewJjRuntime = {
      async runJj() {
        return { stdout: "[]\\t0123456789abcdef\\n", stderr: "", exitCode: 0 };
      },
    };

    await expect(selectDefaultJjCompareTarget(runtime)).resolves.toBe("0123456789abcdef");
  });

  test("reports when JJ cannot resolve a line base", async () => {
    const runtimeFor = (stdout: string, stderr = "", exitCode = 0): ReviewJjRuntime => ({
      async runJj() {
        return { stdout, stderr, exitCode };
      },
    });

    await expect(selectDefaultJjCompareTarget(runtimeFor(""))).rejects.toThrow("not part of a mutable line");
    await expect(selectDefaultJjCompareTarget(runtimeFor("", "unknown revset", 1))).rejects.toThrow("unknown revset");
  });

  test("treats bookmarks and revsets correctly in line-of-work revsets", () => {
    expect(jjLineBaseRevset("main")).toBe('heads(::@ & ::(bookmarks(exact:"main")))');
    expect(jjLineBaseRevset("main@origin")).toBe('heads(::@ & ::(remote_bookmarks(exact:"main", exact:"origin")))');
    expect(jjLineBaseRevset("trunk()")).toBe("heads(::@ & ::(trunk()))");
  });
});

describe("jj evolog", () => {
  test("builds evolog diff args with explicit base", () => {
    expect(getJjDiffArgs("jj-evolog", "abc123456789")).toEqual({
      args: ["diff", "--git", "--from", "abc123456789", "--to", "@"],
      label: "Evolution diff from abc12345",
    });
  });

  test("builds evolog diff args with whitespace flag", () => {
    expect(getJjDiffArgs("jj-evolog", "abc123456789", { hideWhitespace: true })?.args)
      .toEqual(["diff", "--git", "-w", "--from", "abc123456789", "--to", "@"]);
  });

  test("parses evolog output correctly (commit.* template fields)", async () => {
    const runtime: ReviewJjRuntime = {
      async runJj() {
        return {
          stdout: [
            "abc123456789\tAdd login form\t2 minutes ago",
            "def456789012\tAdd login form\t10 minutes ago",
            "ghi789012345\tAdd login form\t1 hour ago",
            "",
          ].join("\n"),
          stderr: "",
          exitCode: 0,
        };
      },
    };
    const entries = await getJjEvoLogEntries(runtime);
    expect(entries).toHaveLength(3);
    expect(entries[0]).toEqual({ commitId: "abc123456789", description: "Add login form", age: "2 minutes ago" });
    expect(entries[1]).toEqual({ commitId: "def456789012", description: "Add login form", age: "10 minutes ago" });
    expect(entries[2]).toEqual({ commitId: "ghi789012345", description: "Add login form", age: "1 hour ago" });
  });

  test("returns empty array when evolog exits non-zero", async () => {
    const runtime: ReviewJjRuntime = {
      async runJj() {
        return { stdout: "", stderr: "error: no such revision", exitCode: 1 };
      },
    };
    const entries = await getJjEvoLogEntries(runtime);
    expect(entries).toHaveLength(0);
  });

  test("defaults to second evolog entry when no base given", async () => {
    let callCount = 0;
    const calls: string[][] = [];
    const runtime: ReviewJjRuntime = {
      async runJj(args) {
        calls.push(args);
        callCount++;
        if (args[0] === "evolog") {
          return {
            stdout: [
              "abc123456789\tFix bug\t1 minute ago",
              "def456789012\tFix bug\t5 minutes ago",
              "",
            ].join("\n"),
            stderr: "",
            exitCode: 0,
          };
        }
        return { stdout: "diff --git a/foo.ts b/foo.ts\n", stderr: "", exitCode: 0 };
      },
    };
    const result = await runJjDiff(runtime, "jj-evolog", "");
    expect(result.label).toBe("Evolution diff from def45678");
    // evolog call + diff call
    expect(callCount).toBe(2);
    const diffCall = calls.find((c) => c[0] === "diff");
    expect(diffCall).toEqual(["diff", "--git", "--from", "def456789012", "--to", "@"]);
  });

  test("returns error when evolog has no previous entry", async () => {
    const runtime: ReviewJjRuntime = {
      async runJj(args) {
        if (args[0] === "evolog") {
          return { stdout: "abc123456789\tInitial commit\t1 minute ago\n", stderr: "", exitCode: 0 };
        }
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    };
    const result = await runJjDiff(runtime, "jj-evolog", "");
    expect(result.error).toBe("No previous evolution found");
    expect(result.patch).toBe("");
  });
});

describe("jj bookmark parsing", () => {
  test("parses escaped newline separators from jj bookmark templates", () => {
    expect(parseJjBookmarkList('"dev"\\n"main"\\n')).toEqual(["dev", "main"]);
  });

  test("parses escaped tab and newline separators from jj remote bookmark templates", () => {
    expect(parseJjRemoteBookmarkList('"main"\\t"git"\\n"release"\\t"origin"\\n')).toEqual([
      "main@git",
      "release@origin",
    ]);
  });

  test("preserves git remote bookmarks from colocated jj repositories", () => {
    expect(parseJjRemoteBookmarkList('"main"\t"git"\n"release"\t"origin"\n')).toEqual([
      "main@git",
      "release@origin",
    ]);
  });
});
