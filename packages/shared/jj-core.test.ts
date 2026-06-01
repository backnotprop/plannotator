import { describe, expect, test } from "bun:test";
import {
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
  test("resolves default target from jj trunk remote bookmarks", async () => {
    const calls: string[][] = [];
    const runtime: ReviewJjRuntime = {
      async runJj(args) {
        calls.push(args);
        return { stdout: '[{"name":"main"},{"name":"main","remote":"origin"}]\n', stderr: "", exitCode: 0 };
      },
    };

    await expect(selectDefaultJjCompareTarget(runtime, "/repo"))
      .resolves.toBe("main@origin");
    expect(calls).toEqual([[
      "log",
      "--no-graph",
      "-r",
      "trunk()",
      "-T",
      "json(bookmarks)",
    ]]);
  });

  test("falls back to local bookmark then trunk revset", async () => {
    const runtimeFor = (stdout: string): ReviewJjRuntime => ({
      async runJj() {
        return { stdout, stderr: "", exitCode: 0 };
      },
    });

    await expect(selectDefaultJjCompareTarget(runtimeFor('[{"name":"develop"}]\n')))
      .resolves.toBe("develop");
    await expect(selectDefaultJjCompareTarget(runtimeFor('[]\n')))
      .resolves.toBe("trunk()");
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
