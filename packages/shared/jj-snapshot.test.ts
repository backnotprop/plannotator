import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { GitCommandResult, ReviewGitRuntime } from "./review-core";
import type { ReviewJjRuntime } from "./jj-core";
import { createJjProvider, createVcsApi } from "./vcs-core";
import { useScratchJjConfig } from "../../tests/helpers/jj-scratch-config";

const jjConfig = useScratchJjConfig();

function hasJj(): boolean {
  try {
    return Bun.spawnSync(["jj", "--version"], { stdout: "pipe", stderr: "pipe" }).exitCode === 0;
  } catch {
    return false;
  }
}

const gitRuntime: ReviewGitRuntime = {
  async runGit(args, options): Promise<GitCommandResult> {
    const result = Bun.spawnSync(["git", ...args], {
      cwd: options?.cwd,
      stdin: options?.stdin === undefined ? undefined : Buffer.from(options.stdin),
      stdout: "pipe",
      stderr: "pipe",
    });
    return {
      stdout: result.stdout.toString(),
      stderr: result.stderr.toString(),
      exitCode: result.exitCode,
    };
  },
  async readTextFile() { return null; },
  async getFileInfo() { return null; },
  async readLink() { return null; },
};

const jjRuntime: ReviewJjRuntime = {
  async runJj(args, options): Promise<GitCommandResult> {
    const result = Bun.spawnSync(["jj", ...args], {
      cwd: options?.cwd,
      env: jjConfig.env(),
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

const vcs = createVcsApi([createJjProvider(jjRuntime, gitRuntime)]);

let workspace = "";

function jj(args: string[]): string {
  const result = Bun.spawnSync(["jj", ...args], { cwd: workspace, env: jjConfig.env(), stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString() || `jj ${args.join(" ")} failed`);
  return result.stdout.toString().trim();
}

function initMergeWorkspace(): void {
  workspace = mkdtempSync(join(tmpdir(), "plannotator-jj-snapshot-"));
  jj(["git", "init", "."]);
  jj(["config", "set", "--repo", "user.name", "Snapshot Test"]);
  jj(["config", "set", "--repo", "user.email", "snapshot-test@example.invalid"]);

  mkdirSync(join(workspace, "sub"), { recursive: true });
  writeFileSync(join(workspace, "base.ts"), "export const base = 1;\n");
  writeFileSync(join(workspace, "sub", "deep.ts"), "export const deep = 1;\n");
  writeFileSync(join(workspace, "notes.md"), "not source\n");
  jj(["commit", "-m", "base"]);
  const base = jj(["log", "--no-graph", "-r", "@-", "-T", "commit_id"]);

  writeFileSync(join(workspace, "a.ts"), "export const a = 1;\n");
  jj(["commit", "-m", "side A"]);
  const sideA = jj(["log", "--no-graph", "-r", "@-", "-T", "commit_id"]);

  jj(["new", base]);
  writeFileSync(join(workspace, "b.ts"), "export const b = 1;\n");
  jj(["commit", "-m", "side B"]);
  const sideB = jj(["log", "--no-graph", "-r", "@-", "-T", "commit_id"]);

  jj(["new", sideA, sideB, "-m", "merge working copy"]);
  writeFileSync(join(workspace, "merged.ts"), "export const merged = 1;\n");
  jj(["status"]);
}

function treeOf(snapshotCwd: string, commit: string): string[] {
  const result = Bun.spawnSync(["git", "ls-tree", "-r", "--name-only", commit], {
    cwd: snapshotCwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString().split("\n").filter(Boolean).sort();
}

afterEach(() => {
  if (workspace) rmSync(workspace, { recursive: true, force: true });
  workspace = "";
});

describe("Jujutsu Call flow snapshots against a real repository", () => {
  const testIfJj = hasJj() ? test : test.skip;

  testIfJj("snapshots jj-current across a merge working copy", async () => {
    initMergeWorkspace();
    const before = jj(["log", "--no-graph", "-r", "@", "-T", "commit_id"]);

    const snapshot = await vcs.materializeVcsSnapshot("jj", {
      cwd: workspace,
      diffType: "jj-current",
      base: "",
      rawPatch: "",
      includedExtensions: [".ts"],
    });
    try {
      expect(treeOf(snapshot.cwd, snapshot.from)).toEqual(["a.ts", "base.ts", "sub/deep.ts"]);
      expect(treeOf(snapshot.cwd, snapshot.to))
        .toEqual(["a.ts", "b.ts", "base.ts", "merged.ts", "sub/deep.ts"]);
    } finally {
      snapshot.cleanup();
    }

    expect(jj(["log", "--no-graph", "-r", "@", "-T", "commit_id"])).toBe(before);
  });

  testIfJj("snapshots jj-last when the last change is reached through a merge", async () => {
    initMergeWorkspace();

    const snapshot = await vcs.materializeVcsSnapshot("jj", {
      cwd: workspace,
      diffType: "jj-last",
      base: "",
      rawPatch: "",
      includedExtensions: [".ts"],
    });
    try {
      expect(treeOf(snapshot.cwd, snapshot.from)).toEqual(["base.ts", "sub/deep.ts"]);
      expect(treeOf(snapshot.cwd, snapshot.to)).toEqual(["a.ts", "base.ts", "sub/deep.ts"]);
    } finally {
      snapshot.cleanup();
    }
  });

  testIfJj("selects the same source files from a subdirectory as from the workspace root", async () => {
    initMergeWorkspace();

    const fromSubdirectory = await vcs.materializeVcsSnapshot("jj", {
      cwd: join(workspace, "sub"),
      diffType: "jj-current",
      base: "",
      rawPatch: "",
      includedExtensions: [".ts"],
    });
    try {
      expect(treeOf(fromSubdirectory.cwd, fromSubdirectory.to))
        .toEqual(["a.ts", "b.ts", "base.ts", "merged.ts", "sub/deep.ts"]);
    } finally {
      fromSubdirectory.cleanup();
    }
  });
});
