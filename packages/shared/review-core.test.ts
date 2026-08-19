import { afterEach, describe, expect, test } from "bun:test";
import {
  isOversizedReviewStubPatch,
  OVERSIZED_REVIEW_STUB_LIMIT_LABEL,
} from "./diff-paths";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import {
  detectRemoteDefaultInfo,
  getDefaultBranch,
  getFileContentsForDiff,
  getGitSnapshotMaterializationPatch,
  getGitContext,
  getGitDiffFingerprint,
  getWorkingTreeDiffFromBase,
  gitAddFile,
  gitResetFile,
  isBinaryPatchFile,
  isSameCwdCommitSwitch,
  listPatchFiles,
  listRecentCommits,
  MAX_REVIEW_FILE_CONTENT_BYTES,
  parseCommitDiffType,
  parseWorktreeDiffType,
  prepareGitCommand,
  runGitDiff,
  splitPorcelainRename,
  type DiffType,
  type GitCommandOptions,
  type GitCommandResult,
  type ReviewGitRuntime,
} from "./review-core";

const unavailableFileMethods = {
  async getFileInfo() { return null; },
  async readLink() { return null; },
};

describe("splitPorcelainRename", () => {
  test("splits a plain rename on the top-level separator", () => {
    expect(splitPorcelainRename("old.txt -> new.txt")).toEqual(["old.txt", "new.txt"]);
  });
  test("returns a single token for a non-rename path", () => {
    expect(splitPorcelainRename("src/app.ts")).toEqual(["src/app.ts"]);
  });
  test("does NOT split on ` -> ` inside a quoted filename", () => {
    // A file literally named `weird -> file.txt` is git-quoted; the internal
    // separator must be ignored so the real file keeps its entry.
    expect(splitPorcelainRename('"weird -> file.txt"')).toEqual(['"weird -> file.txt"']);
  });
  test("splits a rename whose sides are both quoted and contain the separator", () => {
    expect(splitPorcelainRename('"a -> b.txt" -> "c -> d.txt"')).toEqual([
      '"a -> b.txt"',
      '"c -> d.txt"',
    ]);
  });
  test("splits a rename with only the from-side quoted", () => {
    expect(splitPorcelainRename('"a b.txt" -> new.txt')).toEqual(['"a b.txt"', "new.txt"]);
  });
});

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function git(cwd: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf-8" });
  if (result.status !== 0) {
    throw new Error(result.stderr || `git ${args.join(" ")} failed`);
  }
  return result.stdout.trim();
}

function makeRuntime(baseCwd: string): ReviewGitRuntime {
  return {
    async runGit(args: string[], options?: { cwd?: string; stdin?: string }) {
      const result = spawnSync("git", args, {
        cwd: options?.cwd ?? baseCwd,
        encoding: "utf-8",
        maxBuffer: MAX_REVIEW_FILE_CONTENT_BYTES * 4,
        input: options?.stdin,
      });

      return {
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? "",
        exitCode: result.status ?? (result.error ? 1 : 0),
      };
    },

    async readTextFile(path: string) {
      try {
        const fullPath = path.startsWith("/") ? path : resolvePath(baseCwd, path);
        return readFileSync(fullPath, "utf-8");
      } catch {
        return null;
      }
    },

    async getFileInfo(basePath, path) {
      const fullPath = resolvePath(basePath ?? baseCwd, path);
      try {
        const fileStat = lstatSync(fullPath);
        return {
          path: fullPath,
          size: fileStat.size,
          mtimeMs: fileStat.mtimeMs,
          isFile: fileStat.isFile(),
          isSymbolicLink: fileStat.isSymbolicLink(),
          isExecutable: (fileStat.mode & 0o111) !== 0,
        };
      } catch {
        return null;
      }
    },

    async readLink(path: string) {
      try {
        return readlinkSync(path);
      } catch {
        return null;
      }
    },
  };
}

/**
 * Like `makeRuntime`, but routes every command through `prepareGitCommand`
 * and forwards the prepared environment to git — the way the production Bun
 * and Pi runtimes do — so per-command `config` (GIT_CONFIG_*) actually
 * reaches the spawned process. `intercept` lets a test sabotage individual
 * commands (e.g. force the cat-file size probe to fail).
 */
function makeConfigForwardingRuntime(
  baseCwd: string,
  intercept?: (args: string[]) => GitCommandResult | null,
): ReviewGitRuntime {
  const base = makeRuntime(baseCwd);
  return {
    ...base,
    async runGit(args: string[], options?: GitCommandOptions) {
      const intercepted = intercept?.(args);
      if (intercepted) return intercepted;
      const command = prepareGitCommand(args, options, process.env);
      const result = spawnSync("git", command.args, {
        cwd: options?.cwd ?? baseCwd,
        encoding: "utf-8",
        maxBuffer: MAX_REVIEW_FILE_CONTENT_BYTES * 4,
        input: options?.stdin,
        env: command.env as NodeJS.ProcessEnv | undefined,
      });
      return {
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? "",
        exitCode: result.status ?? (result.error ? 1 : 0),
      };
    },
  };
}

function initRepo(initialBranch = "main"): string {
  const repoDir = makeTempDir("plannotator-review-core-");
  git(repoDir, ["init"]);
  git(repoDir, ["branch", "-M", initialBranch]);
  git(repoDir, ["config", "user.email", "review-core@example.com"]);
  git(repoDir, ["config", "user.name", "Review Core"]);

  writeFileSync(join(repoDir, "tracked.txt"), "before\n", "utf-8");
  git(repoDir, ["add", "tracked.txt"]);
  git(repoDir, ["commit", "-m", "initial"]);

  return repoDir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("review-core", () => {
  test("background Git policy is process-local and noninteractive for OpenSSH", () => {
    const environment = {
      PATH: "/usr/bin",
      GIT_SSH_COMMAND: "custom-ssh --proxy jump-host",
    };

    const command = prepareGitCommand(
      ["ls-remote", "--symref", "origin", "HEAD"],
      { timeoutMs: 5_000, interaction: "forbid" },
      environment,
    );

    expect(environment).toEqual({
      PATH: "/usr/bin",
      GIT_SSH_COMMAND: "custom-ssh --proxy jump-host",
    });
    expect(command.args).toEqual([
      "-c",
      "core.quotePath=false",
      "-c",
      "credential.interactive=false",
      "ls-remote",
      "--symref",
      "origin",
      "HEAD",
    ]);
    expect(command.env).toMatchObject({
      PATH: "/usr/bin",
      GIT_TERMINAL_PROMPT: "0",
      GIT_SSH_COMMAND: "custom-ssh --proxy jump-host -o BatchMode=yes -o ConnectTimeout=5",
      SSH_ASKPASS_REQUIRE: "never",
    });
    expect(command.isolateProcessGroup).toBe(true);
  });

  test("background Git policy uses plink batch mode on Windows-style SSH setups", () => {
    const command = prepareGitCommand(
      ["ls-remote", "origin", "HEAD"],
      { timeoutMs: 1_500, interaction: "forbid" },
      {
        GIT_SSH: "C:\\Program Files\\PuTTY\\plink.exe",
        GIT_SSH_VARIANT: "plink",
      },
    );

    expect(command.env?.GIT_TERMINAL_PROMPT).toBe("0");
    expect(command.env?.GIT_SSH_COMMAND).toBe(
      '"C:\\\\Program Files\\\\PuTTY\\\\plink.exe" -batch',
    );
    expect(command.isolateProcessGroup).toBe(true);
  });

  test("interactive Git policy preserves authentication and terminal behavior", () => {
    const command = prepareGitCommand(
      ["fetch", "origin", "main"],
      { timeoutMs: 30_000 },
      {
        GIT_TERMINAL_PROMPT: "1",
        GIT_SSH_COMMAND: "custom-ssh",
      },
    );

    expect(command).toEqual({
      args: ["-c", "core.quotePath=false", "fetch", "origin", "main"],
      isolateProcessGroup: false,
    });
  });

  test("per-command config rides GIT_CONFIG_* environment variables, never argv", () => {
    const command = prepareGitCommand(
      ["diff", "--no-ext-diff", "--cached"],
      { config: { "core.bigFileThreshold": "5242880" } },
      { PATH: "/usr/bin" },
    );

    // argv must stay byte-identical to the configless invocation: callers and
    // test mocks match on the exact argument vector.
    expect(command.args).toEqual(["-c", "core.quotePath=false", "diff", "--no-ext-diff", "--cached"]);
    expect(command.env).toEqual({
      PATH: "/usr/bin",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "core.bigFileThreshold",
      GIT_CONFIG_VALUE_0: "5242880",
    });
    expect(command.isolateProcessGroup).toBe(false);
  });

  test("per-command config appends after config inherited from the environment", () => {
    const command = prepareGitCommand(
      ["diff"],
      { config: { "core.bigFileThreshold": "5242880" } },
      {
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "user.name",
        GIT_CONFIG_VALUE_0: "Env User",
      },
    );

    expect(command.env).toMatchObject({
      GIT_CONFIG_COUNT: "2",
      GIT_CONFIG_KEY_0: "user.name",
      GIT_CONFIG_VALUE_0: "Env User",
      GIT_CONFIG_KEY_1: "core.bigFileThreshold",
      GIT_CONFIG_VALUE_1: "5242880",
    });
  });

  test("per-command config combines with the noninteractive policy environment", () => {
    const command = prepareGitCommand(
      ["cat-file", "--batch-check=%(objectname) %(objecttype) %(objectsize)"],
      { timeoutMs: 5_000, interaction: "forbid", config: { "core.bigFileThreshold": "1" } },
      { PATH: "/usr/bin" },
    );

    expect(command.env).toMatchObject({
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "core.bigFileThreshold",
      GIT_CONFIG_VALUE_0: "1",
      GIT_TERMINAL_PROMPT: "0",
    });
    expect(command.isolateProcessGroup).toBe(true);
  });

  test("remote-default discovery requests bounded noninteractive execution", async () => {
    const calls: Array<{ args: string[]; options: unknown }> = [];
    const runtime: ReviewGitRuntime = {
      ...unavailableFileMethods,
      async runGit(args, options) {
        calls.push({ args, options });
        return { stdout: "", stderr: "origin is absent", exitCode: 2 };
      },
      async readTextFile() {
        return null;
      },
    };

    await expect(detectRemoteDefaultInfo(runtime, "/repo")).resolves.toBeNull();
    expect(calls).toEqual([
      {
        args: ["ls-remote", "--symref", "origin", "HEAD"],
        options: { cwd: "/repo", timeoutMs: 5_000, interaction: "forbid" },
      },
    ]);
  });

  test("remote-default discovery tolerates a repository without an origin", async () => {
    const repoDir = initRepo();
    const runtime = makeRuntime(repoDir);

    await expect(detectRemoteDefaultInfo(runtime, repoDir)).resolves.toBeNull();
  });

  test("remote-default discovery still resolves an accessible ordinary remote", async () => {
    const repoDir = initRepo();
    const remoteDir = makeTempDir("plannotator-review-core-remote-");
    git(remoteDir, ["init", "--bare", "--initial-branch=main"]);
    git(repoDir, ["remote", "add", "origin", remoteDir]);
    git(repoDir, ["push", "--set-upstream", "origin", "main"]);
    const head = git(repoDir, ["rev-parse", "HEAD"]);
    const runtime = makeRuntime(repoDir);

    await expect(detectRemoteDefaultInfo(runtime, repoDir)).resolves.toEqual({
      branch: "origin/main",
      remoteHeadSha: head,
    });
  });

  test("uncommitted diff includes tracked and untracked files", async () => {
    const repoDir = initRepo();
    const runtime = makeRuntime(repoDir);

    writeFileSync(join(repoDir, "tracked.txt"), "after\n", "utf-8");
    writeFileSync(join(repoDir, "untracked.txt"), "brand new\n", "utf-8");

    const result = await runGitDiff(runtime, "uncommitted", "main");

    expect(result.label).toBe("Uncommitted changes");
    expect(result.patch).toContain("diff --git a/tracked.txt b/tracked.txt");
    expect(result.patch).toContain("diff --git a/untracked.txt b/untracked.txt");
    expect(result.patch).toContain("+++ b/untracked.txt");
  });

  test("large untracked files stay visible without diffing their contents", async () => {
    const repoDir = initRepo();
    const runtime = makeRuntime(repoDir);
    writeFileSync(
      join(repoDir, "large build.bin"),
      Buffer.alloc(MAX_REVIEW_FILE_CONTENT_BYTES + 1),
    );

    const result = await runGitDiff(runtime, "uncommitted", "main");

    expect(result.patch).toContain('diff --git "a/large build.bin" "b/large build.bin"');
    expect(result.patch).toContain('Binary files /dev/null and "b/large build.bin" differ');
    expect(listPatchFiles(result.patch)).toContainEqual({
      path: "large build.bin",
      additions: 0,
      deletions: 0,
    });
    expect(isBinaryPatchFile(result.patch, "large build.bin")).toBe(true);
    // Marked so the UI can say WHY the card is empty. A genuine binary file
    // produces the same `Binary files ... differ` line, so the marker is the
    // only thing that tells the two apart.
    expect(isOversizedReviewStubPatch(result.patch)).toBe(true);
  });

  test("the oversized-stub marker is absent from ordinary and genuinely binary diffs", async () => {
    const repoDir = initRepo();
    const runtime = makeRuntime(repoDir);
    writeFileSync(join(repoDir, "notes.txt"), "hello\n", "utf-8");
    // NUL bytes, well under the cap: git calls it binary on its own merits.
    writeFileSync(join(repoDir, "logo.png"), Buffer.from([0, 1, 2, 0, 3]));

    const result = await runGitDiff(runtime, "uncommitted", "main");

    expect(result.patch).toContain("Binary files");
    expect(isOversizedReviewStubPatch(result.patch)).toBe(false);
  });

  test("CallDiff gets an applyable binary patch without changing the UI patch", async () => {
    const repoDir = initRepo();
    const runtime = makeRuntime(repoDir);
    writeFileSync(join(repoDir, "logo.png"), Buffer.from([0, 1, 2, 0, 3]));
    git(repoDir, ["add", "logo.png"]);
    git(repoDir, ["commit", "-m", "add tracked image"]);
    writeFileSync(join(repoDir, "logo.png"), Buffer.from([0, 1, 9, 0, 3, 4]));
    writeFileSync(join(repoDir, "new-logo.png"), Buffer.from([0, 5, 6, 0, 7]));

    const visible = await runGitDiff(runtime, "uncommitted", "main");
    const materialization = await getGitSnapshotMaterializationPatch(
      runtime,
      "uncommitted",
      "main",
      repoDir,
    );

    expect(visible.patch).toContain("Binary files");
    expect(visible.patch).not.toContain("GIT binary patch");
    expect(materialization?.match(/GIT binary patch/g)).toHaveLength(2);
    expect(materialization).toMatch(/^index [0-9a-f]{40,64}\.\.[0-9a-f]{40,64}/m);
  });

  test("the UI's size-cap label matches the enforced byte cap", () => {
    expect(OVERSIZED_REVIEW_STUB_LIMIT_LABEL).toBe(
      `${MAX_REVIEW_FILE_CONTENT_BYTES / (1024 * 1024)} MB`,
    );
  });

  test("large tracked text files render as binary in staged and working-tree diffs (#1120)", async () => {
    const repoDir = initRepo();
    const runtime = makeRuntime(repoDir);
    // Pure text (no NUL bytes), so WITHOUT the size guard git would emit the
    // whole multi-megabyte text patch — the memory blowup #1120 reports once a
    // large file is staged into (or modified in) the tracked diff.
    const bigText = "a".repeat(MAX_REVIEW_FILE_CONTENT_BYTES + 100);
    writeFileSync(join(repoDir, "artifact.js"), bigText, "utf-8");
    git(repoDir, ["add", "artifact.js"]);

    const staged = await runGitDiff(runtime, "staged", "main");
    expect(staged.patch).toContain("diff --git a/artifact.js b/artifact.js");
    expect(staged.patch).toContain("Binary files /dev/null and b/artifact.js differ");
    expect(isBinaryPatchFile(staged.patch, "artifact.js")).toBe(true);
    // The oversized contents never entered the buffered patch.
    expect(staged.patch).not.toContain("aaaaaaaaaa");
    expect(staged.patch.length).toBeLessThan(1024);

    // The same file, seen through the working-tree views (git diff HEAD /
    // merge-base), is bounded the same way.
    const uncommitted = await runGitDiff(runtime, "uncommitted", "main");
    expect(isBinaryPatchFile(uncommitted.patch, "artifact.js")).toBe(true);
    expect(uncommitted.patch).not.toContain("aaaaaaaaaa");
    const sinceBase = await runGitDiff(runtime, "since-base", "main");
    expect(isBinaryPatchFile(sinceBase.patch, "artifact.js")).toBe(true);
    expect(sinceBase.patch).not.toContain("aaaaaaaaaa");
  });

  test("equal-sized tracked worktree edits stay bounded with textconv and change the fingerprint", async () => {
    const repoDir = initRepo();
    writeFileSync(join(repoDir, ".gitattributes"), "tracked.txt diff=force-text\n", "utf-8");
    git(repoDir, ["add", ".gitattributes"]);
    git(repoDir, ["commit", "-m", "configure textconv"]);
    git(repoDir, ["config", "diff.force-text.textconv", "cat"]);

    const largeSize = MAX_REVIEW_FILE_CONTENT_BYTES + 1;
    writeFileSync(
      join(repoDir, "tracked.txt"),
      "a".repeat(largeSize),
      "utf-8",
    );
    git(repoDir, ["add", "tracked.txt"]);
    git(repoDir, ["commit", "-m", "add large tracked text"]);

    writeFileSync(join(repoDir, "tracked.txt"), "b".repeat(largeSize), "utf-8");
    const direct = await runGitDiff(makeRuntime(repoDir), "uncommitted", "main");
    expect(direct.patch.length).toBeLessThan(2_000);
    expect(direct.patch).not.toContain("bbbbbbbbbb");
    expect(direct.patch).toContain("Binary files");

    const baseRuntime = makeRuntime(repoDir);
    const renderedPatches: string[] = [];
    const runtime: ReviewGitRuntime = {
      ...baseRuntime,
      async runGit(args, options) {
        const result = await baseRuntime.runGit(args, options);
        const commandArgs = args[0] === "--no-optional-locks" ? args.slice(1) : args;
        if (commandArgs[0] === "diff" && !commandArgs.includes("--raw")) {
          renderedPatches.push(result.stdout);
        }
        return result;
      },
    };
    const first = await getGitDiffFingerprint(runtime, "uncommitted", "main");
    expect(first).not.toBeNull();

    writeFileSync(join(repoDir, "tracked.txt"), "c".repeat(largeSize), "utf-8");
    const second = await getGitDiffFingerprint(runtime, "uncommitted", "main");
    expect(second).not.toBeNull();
    expect(second).not.toBe(first);
    expect(renderedPatches).toHaveLength(2);
    for (const patch of renderedPatches) {
      expect(patch.length).toBeLessThan(2_000);
      expect(patch).not.toContain("bbbbbbbbbb");
      expect(patch).not.toContain("cccccccccc");
    }
  }, 20_000);

  test("keeps exactly the tracked-file content limit as text and omits one byte over", async () => {
    const repoDir = initRepo();
    const runtime = makeRuntime(repoDir);
    const atLimitText = "x\n".repeat(MAX_REVIEW_FILE_CONTENT_BYTES / 2);

    writeFileSync(join(repoDir, "tracked.txt"), atLimitText, "utf-8");
    const atLimit = await runGitDiff(runtime, "uncommitted", "main");
    expect(atLimit.patch.length).toBeGreaterThan(MAX_REVIEW_FILE_CONTENT_BYTES);
    expect(atLimit.patch).toContain("+x\n+x\n");

    writeFileSync(join(repoDir, "tracked.txt"), `${atLimitText}y`, "utf-8");
    const overLimit = await runGitDiff(runtime, "uncommitted", "main");
    expect(overLimit.patch.length).toBeLessThan(2_000);
    expect(overLimit.patch).not.toContain("yyyyyyyyyy");
    expect(isBinaryPatchFile(overLimit.patch, "tracked.txt")).toBe(true);
  }, 20_000);

  test("omits oversized staged adds, deletes, edits, and renames with literal pathspecs", async () => {
    const repoDir = initRepo();
    const baseRuntime = makeRuntime(repoDir);
    const gitCalls: string[][] = [];
    const runtime: ReviewGitRuntime = {
      ...baseRuntime,
      async runGit(args, options) {
        gitCalls.push(args);
        return baseRuntime.runGit(args, options);
      },
    };
    const modified = "modify [*]?.txt";
    const deleted = "delete space [*]?.txt";
    const renamedFrom = "rename from [*]?.txt";
    const renamedTo = "rename to [*]?.txt";
    const added = "add [*]?.txt";

    writeFileSync(join(repoDir, modified), "m".repeat(MAX_REVIEW_FILE_CONTENT_BYTES + 1), "utf-8");
    writeFileSync(join(repoDir, deleted), "d".repeat(MAX_REVIEW_FILE_CONTENT_BYTES + 1), "utf-8");
    writeFileSync(join(repoDir, renamedFrom), "r".repeat(MAX_REVIEW_FILE_CONTENT_BYTES + 1), "utf-8");
    git(repoDir, ["add", "."]);
    git(repoDir, ["commit", "-m", "add oversized tracked files"]);
    git(repoDir, ["config", "diff.renames", "false"]);

    writeFileSync(join(repoDir, modified), "n".repeat(MAX_REVIEW_FILE_CONTENT_BYTES + 1), "utf-8");
    git(repoDir, ["rm", deleted]);
    writeFileSync(join(repoDir, added), "z".repeat(MAX_REVIEW_FILE_CONTENT_BYTES + 1), "utf-8");
    git(repoDir, ["add", "."]);

    const changed = await runGitDiff(runtime, "staged", "main");

    expect(changed.patch.length).toBeLessThan(8_000);
    expect(changed.patch).toContain("Binary files");
    expect(changed.patch).not.toContain("mmmmmmmmmm");
    expect(changed.patch).not.toContain("nnnnnnnnnn");
    expect(listPatchFiles(changed.patch).map((file) => file.path)).toEqual(
      expect.arrayContaining([modified, deleted, added]),
    );
    for (const path of [modified, deleted, added]) {
      expect(gitCalls.some((args) => args.includes(`:(top,exclude,literal)${path}`))).toBe(true);
    }

    git(repoDir, ["reset", "--hard", "HEAD"]);
    git(repoDir, ["config", "diff.renames", "true"]);
    git(repoDir, ["mv", renamedFrom, renamedTo]);
    git(repoDir, ["add", "."]);
    const renamed = await runGitDiff(runtime, "staged", "main");
    expect(renamed.patch.length).toBeLessThan(2_000);
    expect(renamed.patch).not.toContain("Binary files");
    expect(listPatchFiles(renamed.patch).map((file) => file.path)).toContain(renamedTo);
  }, 20_000);

  test("keeps gitlink pointers as normal subproject diffs and fingerprints them", async () => {
    const superproject = initRepo();
    const submoduleSource = makeTempDir("plannotator-review-core-submodule-");
    git(submoduleSource, ["init"]);
    git(submoduleSource, ["config", "user.email", "submodule@example.com"]);
    git(submoduleSource, ["config", "user.name", "Submodule"]);
    writeFileSync(join(submoduleSource, "module.txt"), "first\n", "utf-8");
    git(submoduleSource, ["add", "module.txt"]);
    git(submoduleSource, ["commit", "-m", "first"]);
    const first = git(submoduleSource, ["rev-parse", "HEAD"]);

    git(superproject, [
      "-c",
      "protocol.file.allow=always",
      "-c",
      "core.hooksPath=/dev/null",
      "submodule",
      "add",
      submoduleSource,
      "deps/module",
    ]);
    git(superproject, ["commit", "-m", "add submodule"]);

    writeFileSync(join(submoduleSource, "module.txt"), "second\n", "utf-8");
    git(submoduleSource, ["add", "module.txt"]);
    git(submoduleSource, ["commit", "-m", "second"]);
    const second = git(submoduleSource, ["rev-parse", "HEAD"]);
    git(superproject, [
      "-C",
      "deps/module",
      "-c",
      "protocol.file.allow=always",
      "-c",
      "core.hooksPath=/dev/null",
      "fetch",
      "origin",
    ]);
    git(superproject, ["-C", "deps/module", "-c", "core.hooksPath=/dev/null", "checkout", second]);
    git(superproject, ["add", "deps/module"]);

    const runtime = makeRuntime(superproject);
    const staged = await runGitDiff(runtime, "staged", "main");
    expect(staged.patch).toContain(`-Subproject commit ${first}`);
    expect(staged.patch).toContain(`+Subproject commit ${second}`);
    expect(staged.patch).not.toContain("Binary files");
    const firstFingerprint = await getGitDiffFingerprint(runtime, "staged", "main");

    writeFileSync(join(submoduleSource, "module.txt"), "third\n", "utf-8");
    git(submoduleSource, ["add", "module.txt"]);
    git(submoduleSource, ["commit", "-m", "third"]);
    const third = git(submoduleSource, ["rev-parse", "HEAD"]);
    git(superproject, [
      "-C",
      "deps/module",
      "-c",
      "protocol.file.allow=always",
      "-c",
      "core.hooksPath=/dev/null",
      "fetch",
      "origin",
    ]);
    git(superproject, ["-C", "deps/module", "-c", "core.hooksPath=/dev/null", "checkout", third]);
    git(superproject, ["add", "deps/module"]);

    const secondFingerprint = await getGitDiffFingerprint(runtime, "staged", "main");
    expect(secondFingerprint).not.toBe(firstFingerprint);
  }, 20_000);

  test("preserves small textconv output while excluding oversized textconv paths", async () => {
    const repoDir = initRepo();
    const textconv = join(repoDir, "textconv.sh");
    writeFileSync(
      textconv,
      ["#!/bin/sh", "printf 'rendered:'", 'cat "$1"', ""].join("\n"),
      "utf-8",
    );
    chmodSync(textconv, 0o755);
    writeFileSync(join(repoDir, ".gitattributes"), "*.txt diff=rendered\n", "utf-8");
    writeFileSync(join(repoDir, "small.txt"), "small before\n", "utf-8");
    writeFileSync(
      join(repoDir, "large.txt"),
      "a".repeat(MAX_REVIEW_FILE_CONTENT_BYTES + 1),
      "utf-8",
    );
    git(repoDir, ["add", ".gitattributes", "small.txt", "large.txt"]);
    git(repoDir, ["commit", "-m", "configure textconv"]);
    git(repoDir, ["config", "diff.rendered.textconv", textconv]);

    writeFileSync(join(repoDir, "small.txt"), "small after\n", "utf-8");
    writeFileSync(
      join(repoDir, "large.txt"),
      "b".repeat(MAX_REVIEW_FILE_CONTENT_BYTES + 1),
      "utf-8",
    );

    const result = await runGitDiff(makeRuntime(repoDir), "uncommitted", "main");

    expect(result.patch).toContain("+rendered:small after");
    expect(result.patch).toContain("Binary files");
    expect(result.patch).not.toContain("bbbbbbbbbb");
    expect(result.patch.length).toBeLessThan(4_000);
  }, 20_000);

  test("does not mark unchanged oversized rename or mode-only stubs as binary", async () => {
    const objectId = "a".repeat(40);
    const runtime: ReviewGitRuntime = {
      ...unavailableFileMethods,
      async runGit(args, options) {
        if (args[0] === "diff" && args.includes("--raw")) {
          return {
            stdout: [
              `:100644 100644 ${objectId} ${objectId} R100`,
              "old-large.txt",
              "new-large.txt",
              `:100644 100755 ${objectId} ${objectId} M`,
              "mode-large.txt",
              "",
            ].join("\0"),
            stderr: "",
            exitCode: 0,
          };
        }
        if (args[0] === "cat-file" && args.some((arg) => arg.startsWith("--batch-check"))) {
          const input = (options as { stdin?: string } | undefined)?.stdin ?? "";
          return {
            stdout: input.trim().split("\n").map((id) =>
              `${id} blob ${MAX_REVIEW_FILE_CONTENT_BYTES + 1}`,
            ).join("\n"),
            stderr: "",
            exitCode: 0,
          };
        }
        if (args[0] === "rev-parse") return { stdout: "/repo\n", stderr: "", exitCode: 0 };
        if (args[0] === "diff") return { stdout: "", stderr: "", exitCode: 0 };
        throw new Error(`Unexpected git command: ${args.join(" ")}`);
      },
      async readTextFile() {
        return null;
      },
    };

    const result = await runGitDiff(runtime, "staged", "main", "/repo");

    expect(result.patch).toContain("rename from old-large.txt");
    expect(result.patch).toContain("old mode 100644\nnew mode 100755");
    expect(result.patch).not.toContain("Binary files");
  });

  test("fingerprinting oversized tracked worktree files uses metadata without hashing them", async () => {
    const repoDir = initRepo();
    const largeSize = MAX_REVIEW_FILE_CONTENT_BYTES + 1;
    writeFileSync(join(repoDir, "tracked.txt"), "a".repeat(largeSize), "utf-8");
    git(repoDir, ["add", "tracked.txt"]);
    git(repoDir, ["commit", "-m", "add large file"]);

    const baseRuntime = makeRuntime(repoDir);
    let hashObjectCalls = 0;
    const runtime: ReviewGitRuntime = {
      ...baseRuntime,
      async runGit(args, options) {
        if (args[0] === "--no-optional-locks" && args[1] === "hash-object") {
          hashObjectCalls++;
        }
        return baseRuntime.runGit(args, options);
      },
    };

    writeFileSync(join(repoDir, "tracked.txt"), "b".repeat(largeSize), "utf-8");
    const first = await getGitDiffFingerprint(runtime, "uncommitted", "main");
    writeFileSync(join(repoDir, "tracked.txt"), `b${"b".repeat(largeSize)}`, "utf-8");
    const second = await getGitDiffFingerprint(runtime, "uncommitted", "main");

    expect(first).not.toBeNull();
    expect(second).not.toBe(first);
    expect(hashObjectCalls).toBe(0);
  }, 20_000);

  test("preflights many tracked objects with one cat-file batch query", async () => {
    const objectIds = Array.from({ length: 12 }, (_, index) => index.toString(16).padStart(40, "0"));
    let individualSizeCalls = 0;
    let batchCalls = 0;
    const runtime: ReviewGitRuntime = {
      ...unavailableFileMethods,
      async runGit(args, options) {
        if (args[0] === "diff" && args.includes("--raw")) {
          return {
            stdout: objectIds.map((objectId, index) =>
              `:100644 100644 ${objectId} ${objectId} M\0file-${index}.txt\0`,
            ).join(""),
            stderr: "",
            exitCode: 0,
          };
        }
        if (args[0] === "cat-file" && args[1] === "-s") {
          individualSizeCalls++;
          return { stdout: `${MAX_REVIEW_FILE_CONTENT_BYTES + 1}\n`, stderr: "", exitCode: 0 };
        }
        if (args[0] === "cat-file" && args.some((arg) => arg.startsWith("--batch-check"))) {
          batchCalls++;
          const input = (options as { stdin?: string } | undefined)?.stdin ?? "";
          return {
            stdout: input.trim().split("\n").map((objectId) =>
              `${objectId} blob ${MAX_REVIEW_FILE_CONTENT_BYTES + 1}`,
            ).join("\n"),
            stderr: "",
            exitCode: 0,
          };
        }
        if (args[0] === "rev-parse") return { stdout: "/repo\n", stderr: "", exitCode: 0 };
        if (args[0] === "diff") return { stdout: "", stderr: "", exitCode: 0 };
        throw new Error(`Unexpected git command: ${args.join(" ")}`);
      },
      async readTextFile() {
        return null;
      },
    };

    const result = await runGitDiff(runtime, "staged", "main", "/repo");

    expect(result.patch.length).toBeLessThan(8_000);
    expect(batchCalls).toBe(1);
    expect(individualSizeCalls).toBe(0);
  });

  test("a failed size probe renders the diff instead of blanking it with binary stubs", async () => {
    const renderedPatch =
      "diff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-old\n+new\n";
    const calls: Array<{ args: string[]; options?: GitCommandOptions }> = [];
    const runtime: ReviewGitRuntime = {
      ...unavailableFileMethods,
      async runGit(args, options) {
        calls.push({ args, options });
        if (args[0] === "diff" && args.includes("--raw")) {
          return {
            stdout: `:100644 100644 ${"a".repeat(40)} ${"b".repeat(40)} M\0x.ts\0`,
            stderr: "",
            exitCode: 0,
          };
        }
        if (args[0] === "cat-file" && args.some((arg) => arg.startsWith("--batch-check"))) {
          return { stdout: "", stderr: "fatal: unable to read object database", exitCode: 128 };
        }
        if (args[0] === "rev-parse") return { stdout: "/repo\n", stderr: "", exitCode: 0 };
        if (args[0] === "diff") return { stdout: renderedPatch, stderr: "", exitCode: 0 };
        throw new Error(`Unexpected git command: ${args.join(" ")}`);
      },
      async readTextFile() {
        return null;
      },
    };

    const result = await runGitDiff(runtime, "staged", "main", "/repo");

    // The review shows the real diff — not one binary stub per file.
    expect(result.patch).toContain("+new");
    expect(result.patch).not.toContain("Binary files");
    expect(
      calls.some(({ args }) => args.some((arg) => arg.startsWith(":(top,exclude,literal)"))),
    ).toBe(false);

    // The probe is timeout-guarded and noninteractive so a hung git cannot
    // stall the review server.
    const probe = calls.find(({ args }) => args[0] === "cat-file");
    expect(probe?.options).toMatchObject({ timeoutMs: 5000, interaction: "forbid" });

    // Memory stays bounded by git itself: the rendered diff carries the
    // core.bigFileThreshold config while argv stays byte-identical.
    const rendered = calls.filter(
      ({ args }) => args[0] === "diff" && !args.includes("--raw"),
    );
    expect(rendered.length).toBeGreaterThan(0);
    for (const { args, options } of rendered) {
      expect(options?.config).toEqual({
        "core.bigFileThreshold": String(MAX_REVIEW_FILE_CONTENT_BYTES),
      });
      expect(args.some((arg) => arg.includes("bigFileThreshold"))).toBe(false);
    }
  });

  test("a probed-oversized object excludes only its path, and a missing one none", async () => {
    // Per-object evidence stays per-object: one oversized blob costs one path,
    // never the whole review. An object the probe cannot SIZE is a different
    // answer from one it sizes above the cap: `missing` is unknown, so that
    // path keeps rendering under git's own core.bigFileThreshold bound.
    const smallOld = "1".repeat(40);
    const smallNew = "2".repeat(40);
    const missingOld = "3".repeat(40);
    const missingNew = "4".repeat(40);
    const hugeOld = "5".repeat(40);
    const hugeNew = "6".repeat(40);
    const renderedPatch = [
      "diff --git a/small.ts b/small.ts\n-old\n+new\n",
      "diff --git a/unfetched.ts b/unfetched.ts\n-gone\n+restored\n",
    ].join("");
    const excludedPaths: string[] = [];
    const runtime: ReviewGitRuntime = {
      ...unavailableFileMethods,
      async runGit(args, options) {
        if (args[0] === "diff" && args.includes("--raw")) {
          return {
            stdout: [
              `:100644 100644 ${smallOld} ${smallNew} M\0small.ts\0`,
              `:100644 100644 ${missingOld} ${missingNew} M\0unfetched.ts\0`,
              `:100644 100644 ${hugeOld} ${hugeNew} M\0huge.bin\0`,
            ].join(""),
            stderr: "",
            exitCode: 0,
          };
        }
        if (args[0] === "cat-file" && args.some((arg) => arg.startsWith("--batch-check"))) {
          const input = (options as { stdin?: string } | undefined)?.stdin ?? "";
          return {
            stdout: input.trim().split("\n").filter(Boolean).map((objectId) => {
              if (objectId === missingNew) return `${objectId} missing`;
              if (objectId === hugeNew) {
                return `${objectId} blob ${MAX_REVIEW_FILE_CONTENT_BYTES + 1}`;
              }
              return `${objectId} blob 10`;
            }).join("\n"),
            stderr: "",
            exitCode: 0,
          };
        }
        if (args[0] === "rev-parse") return { stdout: "/repo\n", stderr: "", exitCode: 0 };
        if (args[0] === "diff") {
          excludedPaths.push(
            ...args.filter((arg) => arg.startsWith(":(top,exclude,literal)")),
          );
          return { stdout: renderedPatch, stderr: "", exitCode: 0 };
        }
        throw new Error(`Unexpected git command: ${args.join(" ")}`);
      },
      async readTextFile() {
        return null;
      },
    };

    const result = await runGitDiff(runtime, "staged", "main", "/repo");

    expect(result.patch).toContain("+new");
    expect(result.patch).toContain("Binary files a/huge.bin and b/huge.bin differ");
    expect(excludedPaths).toEqual([":(top,exclude,literal)huge.bin"]);
    // The unfetchable object's path is not stubbed away: git renders it, and
    // a git that truly cannot read it fails loudly instead of blanking it.
    expect(result.patch).toContain("+restored");
    expect(result.patch).not.toContain("Binary files a/unfetched.ts");
    expect(result.patch).not.toContain("Binary files a/small.ts");
  });

  test("a failed size probe keeps oversized committed blobs git-bounded", async () => {
    const repoDir = initRepo();
    const largeSize = MAX_REVIEW_FILE_CONTENT_BYTES + 1;
    writeFileSync(join(repoDir, "big.txt"), "a".repeat(largeSize), "utf-8");
    writeFileSync(join(repoDir, "tracked.txt"), "after\n", "utf-8");
    git(repoDir, ["add", "big.txt", "tracked.txt"]);

    const runtime = makeConfigForwardingRuntime(repoDir, (args) =>
      args.some((arg) => arg.startsWith("--batch-check"))
        ? { stdout: "", stderr: "fatal: probe unavailable", exitCode: 128 }
        : null,
    );

    const result = await runGitDiff(runtime, "staged", "main");

    // The small file's real diff survives — the review is not blanked.
    expect(result.patch).toContain("+after");
    // git's own core.bigFileThreshold stubs the oversized staged blob.
    expect(result.patch).toContain("Binary files");
    expect(result.patch).not.toContain("aaaaaaaaaa");
    expect(result.patch.length).toBeLessThan(4_000);
  }, 20_000);

  test("a failed size probe still excludes oversized working-tree files by stat", async () => {
    const repoDir = initRepo();
    const largeSize = MAX_REVIEW_FILE_CONTENT_BYTES + 1;
    writeFileSync(join(repoDir, "big.txt"), "a".repeat(largeSize), "utf-8");
    git(repoDir, ["add", "big.txt"]);
    git(repoDir, ["commit", "-m", "add big file"]);

    // Dirty working tree: core.bigFileThreshold does NOT bound the worktree
    // side of a diff (git hashes the file and content-based binary detection
    // wins), so the stat-based exclusion door must work without the probe.
    writeFileSync(join(repoDir, "big.txt"), "b".repeat(largeSize), "utf-8");
    writeFileSync(join(repoDir, "tracked.txt"), "after\n", "utf-8");

    const runtime = makeConfigForwardingRuntime(repoDir, (args) =>
      args.some((arg) => arg.startsWith("--batch-check"))
        ? { stdout: "", stderr: "fatal: probe unavailable", exitCode: 128 }
        : null,
    );

    const result = await runGitDiff(runtime, "uncommitted", "main");

    expect(result.patch).toContain("+after");
    expect(result.patch).toContain("Binary files");
    expect(result.patch).not.toContain("bbbbbbbbbb");
    expect(result.patch.length).toBeLessThan(4_000);
  }, 20_000);

  test("staleness fingerprinting survives a failed size probe and still tracks content", async () => {
    const repoDir = initRepo();
    const largeSize = MAX_REVIEW_FILE_CONTENT_BYTES + 1;
    writeFileSync(join(repoDir, "big.txt"), "a".repeat(largeSize), "utf-8");
    git(repoDir, ["add", "big.txt"]);
    git(repoDir, ["commit", "-m", "add big file"]);

    const runtime = makeConfigForwardingRuntime(repoDir, (args) =>
      args.some((arg) => arg.startsWith("--batch-check"))
        ? { stdout: "", stderr: "fatal: probe unavailable", exitCode: 128 }
        : null,
    );

    writeFileSync(join(repoDir, "big.txt"), "b".repeat(largeSize), "utf-8");
    const first = await getGitDiffFingerprint(runtime, "uncommitted", "main");
    writeFileSync(join(repoDir, "big.txt"), "b".repeat(largeSize + 1), "utf-8");
    const second = await getGitDiffFingerprint(runtime, "uncommitted", "main");

    // Best-effort semantics preserved: the probe failing must not turn the
    // staleness poll into a permanent false all-clear.
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(second).not.toBe(first);
  }, 20_000);

  test("renders a renamed file whose edited worktree blob the probe cannot find", async () => {
    // Rename/copy detection makes git hash the WORKING-TREE content and print
    // that hash in --raw output, but the blob is never written to the object
    // database. The size probe answers `missing` for it. Treating that as
    // "oversized" dropped the whole renamed file out of the review (#1167).
    const repoDir = initRepo();
    mkdirSync(join(repoDir, "src"));
    const original = Array.from({ length: 40 }, (_, index) => `line ${index + 1}`).join("\n");
    writeFileSync(join(repoDir, "src/Card.tsx"), `${original}\n`, "utf-8");
    git(repoDir, ["add", "-A"]);
    git(repoDir, ["commit", "-m", "add card"]);
    const base = git(repoDir, ["rev-parse", "HEAD"]);
    git(repoDir, ["mv", "src/Card.tsx", "src/Panel.tsx"]);
    git(repoDir, ["commit", "-m", "rename card to panel"]);
    writeFileSync(
      join(repoDir, "src/Panel.tsx"),
      `${original}\nline 41 unstaged\n`,
      "utf-8",
    );

    const runtime = makeConfigForwardingRuntime(repoDir);
    const patch = await getWorkingTreeDiffFromBase(runtime, base);

    expect(patch).toContain("+line 41 unstaged");
    expect(patch).not.toContain("Binary files");
  }, 20_000);

  test("renders a tracked add whose worktree blob the probe cannot find", async () => {
    // A delete/add pair also feeds rename detection, so the added path carries
    // a real-but-unwritten worktree hash in --raw output.
    const repoDir = initRepo();
    const base = git(repoDir, ["rev-parse", "HEAD"]);
    writeFileSync(join(repoDir, "replacement.txt"), "fresh content\n", "utf-8");
    git(repoDir, ["rm", "-q", "tracked.txt"]);
    git(repoDir, ["add", "-A"]);
    git(repoDir, ["commit", "-m", "replace tracked file"]);
    writeFileSync(join(repoDir, "replacement.txt"), "fresh content\nedited later\n", "utf-8");

    const runtime = makeConfigForwardingRuntime(repoDir);
    const patch = await getWorkingTreeDiffFromBase(runtime, base);

    expect(patch).toContain("+fresh content");
    expect(patch).toContain("+edited later");
    expect(patch).not.toContain("Binary files");
  }, 20_000);

  test("renders a file whose index blob is missing from the object database", async () => {
    // Partial clones (and pruned object databases) can report `missing` for an
    // index blob git can still diff perfectly well from the working tree.
    const repoDir = initRepo();
    writeFileSync(join(repoDir, "added.txt"), "content from the index\n", "utf-8");
    git(repoDir, ["add", "added.txt"]);
    const blobId = git(repoDir, ["rev-parse", ":added.txt"]);
    rmSync(join(repoDir, ".git", "objects", blobId.slice(0, 2), blobId.slice(2)), { force: true });

    const runtime = makeConfigForwardingRuntime(repoDir);
    const result = await runGitDiff(runtime, "uncommitted", "main");

    expect(result.patch).toContain("+content from the index");
    expect(result.patch).not.toContain("Binary files");
  }, 20_000);

  test("still stubs an oversized worktree file whose blob the probe cannot find", async () => {
    // The size probe cannot bound this file (its hash is missing) and
    // core.bigFileThreshold does not bound working-tree sides, so the
    // filesystem stat has to be the authoritative bound.
    const repoDir = initRepo();
    const largeSize = MAX_REVIEW_FILE_CONTENT_BYTES + 1;
    writeFileSync(join(repoDir, "old-big.txt"), "a".repeat(largeSize), "utf-8");
    git(repoDir, ["add", "-A"]);
    git(repoDir, ["commit", "-m", "add big file"]);
    const base = git(repoDir, ["rev-parse", "HEAD"]);
    git(repoDir, ["mv", "old-big.txt", "new-big.txt"]);
    git(repoDir, ["commit", "-m", "rename big file"]);
    writeFileSync(join(repoDir, "new-big.txt"), "b".repeat(largeSize), "utf-8");

    const runtime = makeConfigForwardingRuntime(repoDir);
    const patch = await getWorkingTreeDiffFromBase(runtime, base);

    expect(patch).toContain("Binary files");
    expect(patch).not.toContain("bbbbbbbbbb");
    expect(patch.length).toBeLessThan(4_000);
  }, 40_000);

  test("synthesizes quoted rename and copy metadata from raw status details", async () => {
    const renamedFrom = 'old "rename" path';
    const renamedTo = "new \\ rename path";
    const copiedFrom = 'old "copy" path';
    const copiedTo = "new \\ copy path";
    const oldObjectId = "a".repeat(40);
    const newObjectId = "b".repeat(40);
    const runtime: ReviewGitRuntime = {
      ...unavailableFileMethods,
      async runGit(args, options) {
        if (args[0] === "diff" && args.includes("--raw")) {
          return {
            stdout: [
              `:100644 100755 ${oldObjectId} ${newObjectId} R087`,
              renamedFrom,
              renamedTo,
              `:100644 100644 ${oldObjectId} ${newObjectId} C065`,
              copiedFrom,
              copiedTo,
              "",
            ].join("\0"),
            stderr: "",
            exitCode: 0,
          };
        }
        if (args[0] === "cat-file" && args[1] === "-s") {
          return { stdout: `${MAX_REVIEW_FILE_CONTENT_BYTES + 1}\n`, stderr: "", exitCode: 0 };
        }
        if (args[0] === "cat-file" && args.some((arg) => arg.startsWith("--batch-check"))) {
          const input = (options as { stdin?: string } | undefined)?.stdin ?? "";
          return {
            stdout: input.trim().split("\n").map((objectId) =>
              `${objectId} blob ${MAX_REVIEW_FILE_CONTENT_BYTES + 1}`,
            ).join("\n"),
            stderr: "",
            exitCode: 0,
          };
        }
        if (args[0] === "rev-parse") return { stdout: "/repo\n", stderr: "", exitCode: 0 };
        if (args[0] === "diff") return { stdout: "", stderr: "", exitCode: 0 };
        throw new Error(`Unexpected git command: ${args.join(" ")}`);
      },
      async readTextFile() {
        return null;
      },
    };

    const result = await runGitDiff(runtime, "staged", "main", "/repo");

    expect(result.patch).toContain("similarity index 87%");
    expect(result.patch).toContain(`rename from ${JSON.stringify(renamedFrom)}`);
    expect(result.patch).toContain(`rename to ${JSON.stringify(renamedTo)}`);
    expect(result.patch).toContain("old mode 100644\nnew mode 100755");
    expect(result.patch).toContain("similarity index 65%");
    expect(result.patch).toContain(`copy from ${JSON.stringify(copiedFrom)}`);
    expect(result.patch).toContain(`copy to ${JSON.stringify(copiedTo)}`);
    expect(result.patch).not.toContain("similarity index 100%");
  });

  test("binary patch detection follows rename metadata", () => {
    const patch = [
      'diff --git "a/old name.bin" "b/new name.bin"',
      "similarity index 100%",
      "rename from old name.bin",
      "rename to new name.bin",
      "GIT binary patch",
      "",
    ].join("\n");

    expect(isBinaryPatchFile(patch, "new name.bin")).toBe(true);
    expect(isBinaryPatchFile(patch, "old name.bin")).toBe(false);
  });

  test("untracked diff collection caps concurrent git processes", async () => {
    const repoDir = initRepo();
    const baseRuntime = makeRuntime(repoDir);
    for (let index = 0; index < 12; index++) {
      writeFileSync(join(repoDir, `untracked-${index}.txt`), `${index}\n`);
    }
    let active = 0;
    let peak = 0;
    const runtime: ReviewGitRuntime = {
      ...baseRuntime,
      async runGit(args, options) {
        if (!args.includes("--no-index")) return baseRuntime.runGit(args, options);
        active++;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 10));
        try {
          return await baseRuntime.runGit(args, options);
        } finally {
          active--;
        }
      },
    };

    await runGitDiff(runtime, "uncommitted", "main");

    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(4);
  });

  test("ordinary working-tree diffs keep tracked changes when an untracked file cannot be read", async () => {
    const runtime: ReviewGitRuntime = {
      ...unavailableFileMethods,
      async runGit(args) {
        if (args[0] === "rev-parse") {
          return { stdout: "/repo\n", stderr: "", exitCode: 0 };
        }
        if (args[0] === "diff" && args.includes("--raw")) {
          return { stdout: "", stderr: "", exitCode: 0 };
        }
        if (args[0] === "ls-files") {
          return { stdout: "blocked.txt\n", stderr: "", exitCode: 0 };
        }
        if (args[0] === "diff" && args.includes("--no-index")) {
          return { stdout: "", stderr: "error: Could not access blocked.txt", exitCode: 128 };
        }
        if (args[0] === "diff") {
          return { stdout: "tracked patch\n", stderr: "", exitCode: 0 };
        }
        throw new Error(`Unexpected git command: ${args.join(" ")}`);
      },
      async readTextFile() {
        return null;
      },
    };

    await expect(getWorkingTreeDiffFromBase(runtime, "abc123", "/repo")).resolves.toBe(
      "tracked patch\n",
    );
    await expect(getWorkingTreeDiffFromBase(runtime, "abc123", "/repo", undefined, "strict")).rejects.toThrow(
      "Could not access blocked.txt",
    );
  });

  test("ordinary working-tree diffs keep tracked changes when untracked discovery fails", async () => {
    const runtime: ReviewGitRuntime = {
      ...unavailableFileMethods,
      async runGit(args) {
        if (args[0] === "rev-parse") {
          return { stdout: "/repo\n", stderr: "", exitCode: 0 };
        }
        if (args[0] === "diff" && args.includes("--raw")) {
          return { stdout: "", stderr: "", exitCode: 0 };
        }
        if (args[0] === "ls-files") {
          return { stdout: "", stderr: "fatal: cannot read index", exitCode: 128 };
        }
        if (args[0] === "diff") {
          return { stdout: "tracked patch\n", stderr: "", exitCode: 0 };
        }
        throw new Error(`Unexpected git command: ${args.join(" ")}`);
      },
      async readTextFile() {
        return null;
      },
    };

    await expect(getWorkingTreeDiffFromBase(runtime, "abc123", "/repo")).resolves.toBe(
      "tracked patch\n",
    );
    await expect(getWorkingTreeDiffFromBase(runtime, "abc123", "/repo", undefined, "strict"))
      .rejects.toThrow("cannot read index");
  });

  test("since-base includes committed, dirty, and untracked changes", async () => {
    const repoDir = initRepo();
    const runtime = makeRuntime(repoDir);
    git(repoDir, ["checkout", "-b", "feature"]);
    writeFileSync(join(repoDir, "committed.txt"), "committed\n", "utf-8");
    git(repoDir, ["add", "committed.txt"]);
    git(repoDir, ["commit", "-m", "feature commit"]);
    writeFileSync(join(repoDir, "tracked.txt"), "dirty\n", "utf-8");
    writeFileSync(join(repoDir, "untracked.txt"), "new\n", "utf-8");

    const result = await runGitDiff(runtime, "since-base", "main", repoDir);

    expect(result.error).toBeUndefined();
    expect(result.patch).toContain("diff --git a/committed.txt b/committed.txt");
    expect(result.patch).toContain("diff --git a/tracked.txt b/tracked.txt");
    expect(result.patch).toContain("diff --git a/untracked.txt b/untracked.txt");
  });

  test("since-base falls back to HEAD when the requested base cannot resolve", async () => {
    const repoDir = initRepo("trunk");
    const runtime = makeRuntime(repoDir);
    writeFileSync(join(repoDir, "tracked.txt"), "dirty\n", "utf-8");
    writeFileSync(join(repoDir, "untracked.txt"), "new\n", "utf-8");

    const result = await runGitDiff(runtime, "since-base", "missing-base", repoDir);

    expect(result.error).toBeUndefined();
    expect(result.patch).toContain("diff --git a/tracked.txt b/tracked.txt");
    expect(result.patch).toContain("diff --git a/untracked.txt b/untracked.txt");
  });

  test("since-base handles an unborn HEAD without invoking merge-base", async () => {
    const repoDir = makeTempDir("plannotator-review-core-unborn-");
    git(repoDir, ["init"]);
    git(repoDir, ["branch", "-M", "main"]);
    const runtime = makeRuntime(repoDir);
    writeFileSync(join(repoDir, "first.txt"), "first\n", "utf-8");

    const result = await runGitDiff(runtime, "since-base", "main", repoDir);

    expect(result.error).toBeUndefined();
    expect(result.patch).toContain("diff --git a/first.txt b/first.txt");
    expect(result.patch).toContain("+first");
  });

  test("uncommitted diff includes untracked files with C-quoted (unicode) names", async () => {
    // git ls-files C-quotes unusual paths ("caf\303\251.txt"); without
    // unquoting, the --no-index diff can't access the literal quoted name
    // and the file silently drops out of the review.
    const repoDir = initRepo();
    const runtime = makeRuntime(repoDir);

    writeFileSync(join(repoDir, "café.txt"), "accented\n", "utf-8");

    const result = await runGitDiff(runtime, "uncommitted", "main");

    // The content line proves the file was actually read rather than
    // erroring into an empty diff. The header carries git's C-quoted form
    // (core.quotePath), so match the escaped bytes there, not "café".
    expect(result.patch).toContain("+accented");
    expect(result.patch).toContain("caf\\303\\251.txt");
  });

  test("file-content working-tree side resolves root-relative paths from a subdirectory CWD", async () => {
    // Patch paths are repo-root-relative; a review launched from a repo
    // subdirectory must not resolve them against the launch cwd (that
    // double-prefixes the path and hunk expansion returns null).
    const repoDir = initRepo();
    mkdirSync(join(repoDir, "pkg"), { recursive: true });
    writeFileSync(join(repoDir, "pkg", "mod.ts"), "before\n", "utf-8");
    git(repoDir, ["add", "pkg/mod.ts"]);
    git(repoDir, ["commit", "-m", "add pkg"]);
    writeFileSync(join(repoDir, "pkg", "mod.ts"), "after\n", "utf-8");
    writeFileSync(join(repoDir, "tracked.txt"), "root after\n", "utf-8");

    const subCwd = join(repoDir, "pkg");
    const runtime = makeRuntime(subCwd);

    for (const diffType of ["since-base", "uncommitted", "unstaged"] as const) {
      // A file inside the subdir (would double-prefix: pkg/pkg/mod.ts)…
      const sub = await getFileContentsForDiff(runtime, diffType, "main", "pkg/mod.ts", undefined, subCwd);
      expect(sub.newContent).toBe("after\n");
      // …and a root-level file (invisible from the subdir entirely).
      const root = await getFileContentsForDiff(runtime, diffType, "main", "tracked.txt", undefined, subCwd);
      expect(root.newContent).toBe("root after\n");
    }
  });

  test("stage/unstage resolves root-relative pathspecs from a subdirectory CWD", async () => {
    const repoDir = initRepo();
    mkdirSync(join(repoDir, "pkg"), { recursive: true });
    writeFileSync(join(repoDir, "root-new.txt"), "new\n", "utf-8");
    writeFileSync(join(repoDir, "pkg", "sub-new.txt"), "new\n", "utf-8");

    const subCwd = join(repoDir, "pkg");
    const runtime = makeRuntime(subCwd);

    // Root-relative paths, subdirectory cwd — `git add` must run at the
    // toplevel or it fails with "pathspec did not match".
    await gitAddFile(runtime, "root-new.txt", subCwd);
    await gitAddFile(runtime, "pkg/sub-new.txt", subCwd);
    expect(git(repoDir, ["status", "--porcelain"])).toContain("A  root-new.txt");
    expect(git(repoDir, ["status", "--porcelain"])).toContain("A  pkg/sub-new.txt");

    await gitResetFile(runtime, "root-new.txt", subCwd);
    expect(git(repoDir, ["status", "--porcelain"])).toContain("?? root-new.txt");
  });

  test("uncommitted diff includes untracked files when CWD is a subdirectory", async () => {
    const repoDir = initRepo();

    mkdirSync(join(repoDir, "packages", "infra", "lib"), { recursive: true });
    writeFileSync(join(repoDir, "packages", "infra", "lib", "Stack.ts"), "new stack\n", "utf-8");

    writeFileSync(join(repoDir, "root-new.txt"), "root untracked\n", "utf-8");
    mkdirSync(join(repoDir, ".github", "workflows"), { recursive: true });
    writeFileSync(join(repoDir, ".github", "workflows", "ci.yml"), "name: CI\n", "utf-8");

    writeFileSync(join(repoDir, "tracked.txt"), "after\n", "utf-8");

    // Runtime whose default CWD is a subdirectory (simulates a hook process
    // that inherits an agent CWD inside a monorepo package)
    const subCwd = join(repoDir, "packages", "infra");
    const runtime = makeRuntime(subCwd);

    const result = await runGitDiff(runtime, "uncommitted", "main");

    expect(result.patch).toContain("diff --git a/tracked.txt b/tracked.txt");
    expect(result.patch).toContain("diff --git a/packages/infra/lib/Stack.ts b/packages/infra/lib/Stack.ts");
    expect(result.patch).toContain("diff --git a/root-new.txt b/root-new.txt");
    expect(result.patch).toContain("diff --git a/.github/workflows/ci.yml b/.github/workflows/ci.yml");
  });

  test("unstaged diff includes untracked files", async () => {
    const repoDir = initRepo();
    const runtime = makeRuntime(repoDir);

    writeFileSync(join(repoDir, "tracked.txt"), "after\n", "utf-8");
    git(repoDir, ["add", "tracked.txt"]);
    writeFileSync(join(repoDir, "tracked.txt"), "after again\n", "utf-8");
    writeFileSync(join(repoDir, "scratch.txt"), "tmp\n", "utf-8");

    const result = await runGitDiff(runtime, "unstaged", "main");

    expect(result.label).toBe("Unstaged changes");
    expect(result.patch).toContain("diff --git a/tracked.txt b/tracked.txt");
    expect(result.patch).toContain("diff --git a/scratch.txt b/scratch.txt");
  });

  test("staged diff excludes untracked files until they are staged", async () => {
    const repoDir = initRepo();
    const runtime = makeRuntime(repoDir);

    writeFileSync(join(repoDir, "tracked.txt"), "staged change\n", "utf-8");
    git(repoDir, ["add", "tracked.txt"]);
    writeFileSync(join(repoDir, "draft.txt"), "not staged yet\n", "utf-8");

    const stagedOnly = await runGitDiff(runtime, "staged", "main");
    expect(stagedOnly.patch).toContain("diff --git a/tracked.txt b/tracked.txt");
    expect(stagedOnly.patch).not.toContain("draft.txt");

    git(repoDir, ["add", "draft.txt"]);
    const stagedWithNewFile = await runGitDiff(runtime, "staged", "main");
    expect(stagedWithNewFile.patch).toContain("diff --git a/draft.txt b/draft.txt");
  });

  test("branch diff returns an error when the default branch ref is invalid", async () => {
    const repoDir = initRepo("trunk");
    const runtime = makeRuntime(repoDir);

    writeFileSync(join(repoDir, "tracked.txt"), "after\n", "utf-8");

    const context = await getGitContext(runtime);
    expect(context.defaultBranch).toBe("master");

    const result = await runGitDiff(runtime, "branch", context.defaultBranch);

    expect(result.patch).toBe("");
    expect(result.label).toBe("Error: branch");
    // Error is derived from the argv — assert the meaningful parts rather
    // than the exact string so harmless argv reorders (e.g. --end-of-options)
    // don't break it.
    expect(result.error).toContain("git diff");
    expect(result.error).toContain("master..HEAD");
    expect(result.error).not.toContain("core.bigFileThreshold");
  });

  test("git context lists worktrees and file content lookup returns old/new content", async () => {
    const repoDir = initRepo();
    const runtime = makeRuntime(repoDir);

    const worktreeParent = makeTempDir("plannotator-review-core-worktree-");
    const worktreeDir = join(worktreeParent, "feature-worktree");
    git(repoDir, ["worktree", "add", "-b", "feature/review-core", worktreeDir]);

    writeFileSync(join(repoDir, "tracked.txt"), "after\n", "utf-8");
    writeFileSync(join(repoDir, "new-file.txt"), "brand new\n", "utf-8");

    const context = await getGitContext(runtime);
    expect(context.diffOptions.map((option) => option.id)).toEqual(
      expect.arrayContaining(["uncommitted", "staged", "unstaged", "last-commit"]),
    );
    expect(
      context.worktrees.some((worktree) => worktree.path.endsWith("/feature-worktree")),
    ).toBe(true);

    const trackedContents = await getFileContentsForDiff(
      runtime,
      "uncommitted",
      context.defaultBranch,
      "tracked.txt",
    );
    expect(trackedContents.oldContent).toBe("before\n");
    expect(trackedContents.newContent).toBe("after\n");

    const newFileContents = await getFileContentsForDiff(
      runtime,
      "uncommitted",
      context.defaultBranch,
      "new-file.txt",
    );
    expect(newFileContents.oldContent).toBeNull();
    expect(newFileContents.newContent).toBe("brand new\n");
  });

  test("file-content expansion uses runtime filesystem capabilities", async () => {
    const inspectedPaths: Array<[string, string]> = [];
    const readPaths: string[] = [];
    const runtime: ReviewGitRuntime = {
      async runGit(args: string[]) {
        if (args[0] === "rev-parse") {
          return { stdout: "/virtual/repo\n", stderr: "", exitCode: 0 };
        }
        if (args[0] === "cat-file") {
          return { stdout: "", stderr: "missing", exitCode: 1 };
        }
        throw new Error(`Unexpected git command: ${args.join(" ")}`);
      },
      async readTextFile(path: string) {
        readPaths.push(path);
        return path === "/virtual/repo/generated.ts" ? "runtime content\n" : null;
      },
      async getFileInfo(basePath: string | undefined, path: string) {
        if (!basePath) return null;
        inspectedPaths.push([basePath, path]);
        return {
          path: "/virtual/repo/generated.ts",
          size: 16,
          mtimeMs: 1,
          isFile: true,
          isSymbolicLink: false,
          isExecutable: false,
        };
      },
      async readLink() {
        return null;
      },
    };

    await expect(getFileContentsForDiff(
      runtime,
      "uncommitted",
      "main",
      "generated.ts",
    )).resolves.toEqual({ oldContent: null, newContent: "runtime content\n" });
    expect(inspectedPaths).toEqual([["/virtual/repo", "generated.ts"]]);
    expect(readPaths).toEqual(["/virtual/repo/generated.ts"]);
  });

  test("file content lookup refuses oversized working-tree files", async () => {
    const repoDir = initRepo();
    const runtime = makeRuntime(repoDir);
    writeFileSync(
      join(repoDir, "large-generated.js"),
      Buffer.alloc(MAX_REVIEW_FILE_CONTENT_BYTES + 1, 0x20),
    );

    const contents = await getFileContentsForDiff(
      runtime,
      "uncommitted",
      "main",
      "large-generated.js",
    );

    expect(contents).toEqual({ oldContent: null, newContent: null });
  });

  test("file content lookup reads a symlink payload without following its target", async () => {
    const repoDir = initRepo();
    const runtime = makeRuntime(repoDir);
    writeFileSync(
      join(repoDir, "large-target.bin"),
      Buffer.alloc(MAX_REVIEW_FILE_CONTENT_BYTES + 1),
    );
    symlinkSync("large-target.bin", join(repoDir, "generated-link"));

    const contents = await getFileContentsForDiff(
      runtime,
      "uncommitted",
      "main",
      "generated-link",
    );

    expect(contents).toEqual({ oldContent: null, newContent: "large-target.bin" });
  });

  test("getDefaultBranch falls back to local when origin/HEAD points at an unfetched ref", () => {
    // Simulates a narrow / partial clone where origin/HEAD is configured but
    // the target ref was never fetched. Before the verify step, the server
    // would return "origin/phantom" and every branch/merge-base diff would
    // fail with "unknown revision". With the verify step we fall back to
    // local main.
    const repoDir = initRepo();

    // Manually set origin/HEAD → origin/phantom without ever fetching it.
    git(repoDir, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/phantom"]);

    const runtime = makeRuntime(repoDir);
    return getDefaultBranch(runtime).then((result) => {
      expect(result).toBe("main");
    });
  });

  test("getDefaultBranch finds origin/main on feature-only clones (no origin/HEAD, no local main)", async () => {
    // CI checkouts / `clone --branch feature` / extra worktrees: only the
    // feature branch exists locally, main lives solely as the fetched
    // remote-tracking ref. The old chain (origin/HEAD -> local main ->
    // blind "master") skipped right past it, "master" didn't resolve, and
    // since-base was suppressed for the whole session.
    const repoDir = initRepo();
    const sha = git(repoDir, ["rev-parse", "HEAD"]);
    git(repoDir, ["checkout", "-b", "feature"]);
    git(repoDir, ["branch", "-D", "main"]);
    git(repoDir, ["update-ref", "refs/remotes/origin/main", sha]);

    const runtime = makeRuntime(repoDir);
    expect(await getDefaultBranch(runtime)).toBe("origin/main");
  });

  test("listRecentCommits returns HEAD ancestry with shortSha and subject", async () => {
    const repoDir = initRepo();
    writeFileSync(join(repoDir, "tracked.txt"), "second\n", "utf-8");
    git(repoDir, ["add", "tracked.txt"]);
    git(repoDir, ["commit", "-m", "second commit"]);
    writeFileSync(join(repoDir, "tracked.txt"), "third\n", "utf-8");
    git(repoDir, ["add", "tracked.txt"]);
    git(repoDir, ["commit", "-m", "third commit"]);

    const runtime = makeRuntime(repoDir);
    const commits = await listRecentCommits(runtime, repoDir, 10);

    expect(commits.length).toBe(3);
    expect(commits[0].subject).toBe("third commit");
    expect(commits[1].subject).toBe("second commit");
    expect(commits[2].subject).toBe("initial");
    for (const c of commits) {
      expect(c.sha).toMatch(/^[0-9a-f]{40}$/);
      expect(c.shortSha.length).toBeGreaterThanOrEqual(7);
      expect(c.sha.startsWith(c.shortSha)).toBe(true);
      expect(c.author).toBe("Review Core");
      expect(c.relativeDate.length).toBeGreaterThan(0);
    }
  });

  test("getGitContext includes recentCommits for the picker", async () => {
    const repoDir = initRepo();
    writeFileSync(join(repoDir, "tracked.txt"), "second\n", "utf-8");
    git(repoDir, ["add", "tracked.txt"]);
    git(repoDir, ["commit", "-m", "second commit"]);

    const runtime = makeRuntime(repoDir);
    const context = await getGitContext(runtime, repoDir);

    expect(context.recentCommits).toBeDefined();
    expect(context.recentCommits!.length).toBe(2);
    expect(context.recentCommits![0].subject).toBe("second commit");
  });

  test("parseWorktreeDiffType recognises every DiffType suffix, including merge-base", () => {
    // Regression guard: every local diff type must round-trip through the
    // worktree-prefixed form. Missing `merge-base` here previously routed
    // "worktree:/path:merge-base" to { path: "/path:merge-base", subType: "uncommitted" }
    // which pointed git at a non-existent cwd and silently collapsed the diff mode.
    const subTypes = [
      "since-base",
      "uncommitted",
      "staged",
      "unstaged",
      "last-commit",
      "branch",
      "merge-base",
      "all",
    ] as const;
    for (const sub of subTypes) {
      const composite = `worktree:/tmp/my-worktree:${sub}` as DiffType;
      const parsed = parseWorktreeDiffType(composite);
      expect(parsed).toEqual({ path: "/tmp/my-worktree", subType: sub });
    }
  });

  test("parseWorktreeDiffType recognises commit:<sha> sub-types", () => {
    expect(parseWorktreeDiffType("worktree:/tmp/my-worktree:commit:abc1234")).toEqual({
      path: "/tmp/my-worktree",
      subType: "commit:abc1234",
    });
    // A non-hex suffix is not a commit sub-type — falls back to the path.
    expect(parseWorktreeDiffType("worktree:/tmp/my-worktree:commit:not-hex")).toEqual({
      path: "/tmp/my-worktree:commit:not-hex",
      subType: "uncommitted",
    });
  });

  test("rejects a worktree diff type with no path", () => {
    // An empty path would resolve to an empty cwd; Bun.spawn({ cwd: "" }) runs
    // git in the server's OWN directory and leaks an unrelated repo's diff.
    // Every degenerate form must return null so resolveCwd falls back.
    expect(parseWorktreeDiffType("worktree:")).toBeNull();
    expect(parseWorktreeDiffType("worktree::uncommitted")).toBeNull();
    expect(parseWorktreeDiffType("worktree::commit:abc1234")).toBeNull();
  });
});

describe("isSameCwdCommitSwitch", () => {
  test("true for commit switches within the same cwd, plain and worktree", () => {
    expect(isSameCwdCommitSwitch("since-base", "commit:abc1234")).toBe(true);
    expect(isSameCwdCommitSwitch("commit:abc1234", "commit:def5678")).toBe(true);
    expect(
      isSameCwdCommitSwitch("worktree:/tmp/wt:uncommitted", "worktree:/tmp/wt:commit:abc1234"),
    ).toBe(true);
  });
  test("false when the target isn't a commit diff or the cwd changes", () => {
    expect(isSameCwdCommitSwitch("commit:abc1234", "since-base")).toBe(false);
    expect(isSameCwdCommitSwitch("uncommitted", "worktree:/tmp/wt:commit:abc1234")).toBe(false);
    expect(
      isSameCwdCommitSwitch("worktree:/tmp/a:commit:abc1234", "worktree:/tmp/b:commit:abc1234"),
    ).toBe(false);
  });
});

describe("parseCommitDiffType", () => {
  test("accepts full and abbreviated hex shas", () => {
    expect(parseCommitDiffType("commit:abc1234")).toEqual({ sha: "abc1234" });
    expect(parseCommitDiffType(`commit:${"a".repeat(40)}`)).toEqual({ sha: "a".repeat(40) });
  });
  test("rejects revspec operators, flags, and non-commit types", () => {
    expect(parseCommitDiffType("commit:HEAD~1")).toBeNull();
    expect(parseCommitDiffType("commit:abc1234^{tree}")).toBeNull();
    expect(parseCommitDiffType("commit:--output=/tmp/x")).toBeNull();
    expect(parseCommitDiffType("commit:main..feature")).toBeNull();
    expect(parseCommitDiffType("commit:")).toBeNull();
    expect(parseCommitDiffType("uncommitted")).toBeNull();
  });
});

describe("commit diff mode", () => {
  test("commit:<sha> diffs one commit against its first parent", async () => {
    const repoDir = initRepo();
    const runtime = makeRuntime(repoDir);

    writeFileSync(join(repoDir, "tracked.txt"), "second\n", "utf-8");
    git(repoDir, ["add", "tracked.txt"]);
    git(repoDir, ["commit", "-m", "second commit"]);
    const secondSha = git(repoDir, ["rev-parse", "HEAD"]);

    // A later commit + dirty working tree must NOT leak into the commit's diff.
    writeFileSync(join(repoDir, "third.txt"), "third\n", "utf-8");
    git(repoDir, ["add", "third.txt"]);
    git(repoDir, ["commit", "-m", "third commit"]);
    writeFileSync(join(repoDir, "tracked.txt"), "dirty\n", "utf-8");

    const result = await runGitDiff(runtime, `commit:${secondSha}` as DiffType, "main");

    expect(result.error).toBeUndefined();
    expect(result.label).toMatch(/^Commit [0-9a-f]+ — second commit$/);
    expect(result.patch).toContain("diff --git a/tracked.txt b/tracked.txt");
    expect(result.patch).toContain("+second");
    expect(result.patch).not.toContain("third.txt");
    expect(result.patch).not.toContain("dirty");
  });

  test("a root commit diffs against the empty tree", async () => {
    const repoDir = initRepo();
    const runtime = makeRuntime(repoDir);
    const rootSha = git(repoDir, ["rev-parse", "HEAD"]);

    const result = await runGitDiff(runtime, `commit:${rootSha}` as DiffType, "main");

    expect(result.error).toBeUndefined();
    expect(result.patch).toContain("diff --git a/tracked.txt b/tracked.txt");
    expect(result.patch).toContain("new file mode");
    expect(result.patch).toContain("+before");
  });

  test("an invalid commit ref returns an error, not a git invocation", async () => {
    const repoDir = initRepo();
    const runtime = makeRuntime(repoDir);

    const result = await runGitDiff(runtime, "commit:HEAD~1" as DiffType, "main");

    expect(result.patch).toBe("");
    expect(result.error).toBe("Invalid commit ref");
  });

  test("file contents come from the commit and its parent, not the working tree", async () => {
    const repoDir = initRepo();
    const runtime = makeRuntime(repoDir);

    writeFileSync(join(repoDir, "tracked.txt"), "second\n", "utf-8");
    git(repoDir, ["add", "tracked.txt"]);
    git(repoDir, ["commit", "-m", "second commit"]);
    const secondSha = git(repoDir, ["rev-parse", "HEAD"]);
    writeFileSync(join(repoDir, "tracked.txt"), "dirty\n", "utf-8");

    const contents = await getFileContentsForDiff(
      runtime,
      `commit:${secondSha}` as DiffType,
      "main",
      "tracked.txt",
    );

    expect(contents.oldContent).toBe("before\n");
    expect(contents.newContent).toBe("second\n");
  });

  test("fingerprint is anchored to the sha — new commits do not flip it", async () => {
    const repoDir = initRepo();
    const runtime = makeRuntime(repoDir);
    const rootSha = git(repoDir, ["rev-parse", "HEAD"]);

    const before = await getGitDiffFingerprint(runtime, `commit:${rootSha}` as DiffType, "main");
    expect(before).toBe(`git:commit:${rootSha}:present`);

    writeFileSync(join(repoDir, "later.txt"), "later\n", "utf-8");
    git(repoDir, ["add", "later.txt"]);
    git(repoDir, ["commit", "-m", "later commit"]);
    writeFileSync(join(repoDir, "tracked.txt"), "dirty\n", "utf-8");

    const after = await getGitDiffFingerprint(runtime, `commit:${rootSha}` as DiffType, "main");
    expect(after).toBe(before);
  });
});
