import { describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

  // Every `jj` process below runs against a throwaway JJ_CONFIG. Reading the
  // developer's real config is banned outright by CLAUDE.md, and it is also
  // what makes these fixtures reproducible: commit signing, a custom
  // `immutable_heads()` alias or a non-default `git.push-bookmark-prefix` in a
  // real config would otherwise fail or silently reshape them.
  function createJjSandbox() {
    const root = mkdtempSync(join(tmpdir(), "plannotator-jj-base-"));
    const configPath = join(root, "jj-config.toml");
    writeFileSync(
      configPath,
      '[user]\nname = "Plannotator Test"\nemail = "test@plannotator.invalid"\n',
    );
    const env = { ...process.env, JJ_CONFIG: configPath };

    const jj = (args: string[], options?: { cwd?: string; config?: string[] }) => {
      const result = Bun.spawnSync(["jj", ...(options?.config ?? []), ...args], {
        cwd: options?.cwd ?? root,
        env,
        stdout: "pipe",
        stderr: "pipe",
      });
      if (result.exitCode !== 0) throw new Error(result.stderr.toString());
      return result.stdout.toString();
    };

    const runtime = (config: string[] = []): ReviewJjRuntime => ({
      async runJj(args, options) {
        const result = Bun.spawnSync(["jj", ...config, ...args], {
          cwd: options?.cwd,
          env,
          stdout: "pipe",
          stderr: "pipe",
        });
        return {
          stdout: result.stdout.toString(),
          stderr: result.stderr.toString(),
          exitCode: result.exitCode,
        };
      },
    });

    return {
      root,
      jj,
      runtime,
      cleanup: () => rmSync(root, { recursive: true, force: true }),
    };
  }

  const immutableHeadsAlias = (revset: string) => [
    "--config",
    `revset-aliases."immutable_heads()"=${revset}`,
  ];

  testIfJj("uses the parent of the current mutable line of work", async () => {
    const sandbox = createJjSandbox();
    const workspace = join(sandbox.root, "repo");
    const immutable = immutableHeadsAlias('bookmarks(exact:"development")');
    const jj = (args: string[], config?: string[]) => sandbox.jj(args, { cwd: workspace, config });

    try {
      mkdirSync(workspace);
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

      // Verify the fixture's configured boundary independently of the code under test.
      expect(jj(["log", "--no-graph", "-r", "roots(reachable(@, mutable()))-", "-T", "bookmarks"], immutable).trim())
        .toBe("development");
      await expect(selectDefaultJjCompareTarget(sandbox.runtime(immutable), workspace))
        .resolves.toBe("development");
    } finally {
      sandbox.cleanup();
    }
  });

  // A `jj git push --change` stack carries a generated bookmark on every commit
  // in the line of work. None of them is a base: the review has to start where
  // the whole stack left immutable history, or the reviewer is shown a slice of
  // their own work and told it is the baseline.
  testIfJj("keeps the full line of work when the stack carries generated push bookmarks", async () => {
    const sandbox = createJjSandbox();
    const workspace = join(sandbox.root, "repo");
    const immutable = immutableHeadsAlias('bookmarks(exact:"main")');
    const jj = (args: string[], config?: string[]) => sandbox.jj(args, { cwd: workspace, config });

    try {
      mkdirSync(workspace);
      jj(["git", "init", "."]);
      writeFileSync(join(workspace, "history.txt"), "main\n");
      jj(["commit", "-m", "main"]);
      jj(["bookmark", "create", "main", "-r", "@-"]);

      for (const change of ["push-aaaa", "push-bbbb", "push-cccc"]) {
        appendFileSync(join(workspace, "history.txt"), `${change}\n`);
        jj(["commit", "-m", change]);
        jj(["bookmark", "create", change, "-r", "@-"]);
      }

      await expect(selectDefaultJjCompareTarget(sandbox.runtime(immutable), workspace))
        .resolves.toBe("main");
    } finally {
      sandbox.cleanup();
    }
  });

  // The same generated bookmarks reach the fork point itself once a colleague
  // pushes one: it arrives as an untracked remote bookmark, which is immutable,
  // so the base commit is correct but its only name is machine noise.
  testIfJj("does not name the base after an untracked remote push bookmark", async () => {
    const sandbox = createJjSandbox();
    const remote = join(sandbox.root, "remote.git");
    const colleague = join(sandbox.root, "colleague");
    const workspace = join(sandbox.root, "repo");

    try {
      expect(Bun.spawnSync(["git", "init", "--bare", "-b", "main", remote], { stdout: "pipe", stderr: "pipe" }).exitCode)
        .toBe(0);

      mkdirSync(colleague);
      const asColleague = (args: string[]) => sandbox.jj(args, { cwd: colleague });
      asColleague(["git", "init", "--colocate"]);
      asColleague(["git", "remote", "add", "origin", remote]);
      writeFileSync(join(colleague, "history.txt"), "main\n");
      asColleague(["commit", "-m", "main"]);
      asColleague(["bookmark", "create", "main", "-r", "@-"]);
      asColleague(["git", "push", "-b", "main", "--allow-new"]);
      appendFileSync(join(colleague, "history.txt"), "colleague work\n");
      asColleague(["commit", "-m", "colleague work"]);
      asColleague(["git", "push", "--change", "@-", "--allow-new"]);

      sandbox.jj(["git", "clone", remote, workspace, "--colocate"]);
      const jj = (args: string[]) => sandbox.jj(args, { cwd: workspace });

      const pushBookmark = jj(["bookmark", "list", "--all-remotes", "-T", 'if(remote, name ++ "\\n", "")'])
        .split("\n")
        .map((line) => line.trim())
        .find((name) => name.startsWith("push-"));
      expect(pushBookmark).toBeDefined();

      // The fixture only reproduces the defect while that bookmark is untracked,
      // which is what makes its commit immutable and a candidate base.
      expect(jj(["bookmark", "list", "--all-remotes", "-T", 'if(remote && !tracked, name ++ "\\n", "")']).trim())
        .toContain(pushBookmark!);

      jj(["new", `${pushBookmark}@origin`]);
      appendFileSync(join(workspace, "history.txt"), "my work\n");
      jj(["commit", "-m", "my work"]);

      const baseCommitId = jj(["log", "--no-graph", "-r", `${pushBookmark}@origin`, "-T", "commit_id"]).trim();
      const resolved = await selectDefaultJjCompareTarget(sandbox.runtime(), workspace);
      expect(resolved).not.toContain("push-");
      expect(resolved).toBe(baseCommitId);
      // And that id has to survive the trip into a revset, or the Line of work
      // diff resolves to no revisions at all.
      expect(jjLineBaseRevset(resolved)).toBe(`heads(::@ & ::(${baseCommitId}))`);
      expect(jj(["log", "--no-graph", "-r", jjLineBaseRevset(resolved), "-T", "commit_id"]).trim())
        .toBe(baseCommitId);
    } finally {
      sandbox.cleanup();
    }
  });

  // Local bookmarks confer no immutability in jj, so a stacked feature line is
  // one line of work: the base is where the stack left immutable history, not
  // the bookmark partway up it.
  testIfJj("treats a stacked local bookmark as part of the line of work", async () => {
    const sandbox = createJjSandbox();
    const workspace = join(sandbox.root, "repo");
    const immutable = immutableHeadsAlias('bookmarks(exact:"main")');
    const jj = (args: string[], config?: string[]) => sandbox.jj(args, { cwd: workspace, config });

    try {
      mkdirSync(workspace);
      jj(["git", "init", "."]);
      writeFileSync(join(workspace, "history.txt"), "main\n");
      jj(["commit", "-m", "main"]);
      jj(["bookmark", "create", "main", "-r", "@-"]);

      for (const feature of ["featA", "featB"]) {
        appendFileSync(join(workspace, "history.txt"), `${feature}\n`);
        jj(["commit", "-m", feature]);
        jj(["bookmark", "create", feature, "-r", "@-"]);
      }

      await expect(selectDefaultJjCompareTarget(sandbox.runtime(immutable), workspace))
        .resolves.toBe("main");
    } finally {
      sandbox.cleanup();
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
      "latest(fork_point(roots(reachable(@, mutable()))-), 1)",
      "-T",
      'json(bookmarks) ++ "\\t" ++ commit_id ++ "\\n"',
    ]]);
  });

  // The remote-before-local preference is only meaningful within one commit.
  // `latest(..., 1)` is what keeps the answer to one record; if a second one
  // ever arrives, the nearer commit's local bookmark must still win over a
  // remote bookmark further away.
  test("reads only the first record, so bookmark preference cannot cross commits", async () => {
    const runtime: ReviewJjRuntime = {
      async runJj() {
        return {
          stdout: '[{"name":"nearest"}]\\tabc\\n[{"name":"further","remote":"origin"}]\\tdef\\n',
          stderr: "",
          exitCode: 0,
        };
      },
    };

    await expect(selectDefaultJjCompareTarget(runtime)).resolves.toBe("nearest");
  });

  test("uses the base commit id when it has no usable bookmark", async () => {
    const runtimeFor = (stdout: string): ReviewJjRuntime => ({
      async runJj() {
        return { stdout, stderr: "", exitCode: 0 };
      },
    });

    await expect(selectDefaultJjCompareTarget(runtimeFor("[]\\t0123456789abcdef\\n")))
      .resolves.toBe("0123456789abcdef");
    // A generated push bookmark is not a usable name, so the id is used instead.
    await expect(selectDefaultJjCompareTarget(runtimeFor('[{"name":"push-vmopwunwxopv","remote":"origin"}]\\t0123456789abcdef\\n')))
      .resolves.toBe("0123456789abcdef");
  });

  // The only live caller runs on the review startup path with no handler above
  // it, so an unresolvable base has to degrade to the previous default instead
  // of aborting `plannotator review`.
  test("falls back to the trunk revset when JJ cannot resolve a line base", async () => {
    const runtimeFor = (stdout: string, stderr = "", exitCode = 0): ReviewJjRuntime => ({
      async runJj() {
        return { stdout, stderr, exitCode };
      },
    });

    await expect(selectDefaultJjCompareTarget(runtimeFor(""))).resolves.toBe("trunk()");
    // e.g. a jj too old for `fork_point`/`reachable`.
    await expect(selectDefaultJjCompareTarget(runtimeFor("", "unknown function", 1))).resolves.toBe("trunk()");
    // A repo with no immutable history forks at the all-zero root commit.
    await expect(selectDefaultJjCompareTarget(runtimeFor(`[]\\t${"0".repeat(40)}\\n`))).resolves.toBe("trunk()");
  });

  test("treats bookmarks and revsets correctly in line-of-work revsets", () => {
    expect(jjLineBaseRevset("main")).toBe('heads(::@ & ::(bookmarks(exact:"main")))');
    expect(jjLineBaseRevset("main@origin")).toBe('heads(::@ & ::(remote_bookmarks(exact:"main", exact:"origin")))');
    expect(jjLineBaseRevset("trunk()")).toBe("heads(::@ & ::(trunk()))");
    // A full commit id is a revision, not a bookmark name.
    expect(jjLineBaseRevset("a".repeat(40))).toBe(`heads(::@ & ::(${"a".repeat(40)}))`);
    // A short hex-looking name still reads as a bookmark.
    expect(jjLineBaseRevset("cafebabe")).toBe('heads(::@ & ::(bookmarks(exact:"cafebabe")))');
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
