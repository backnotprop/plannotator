/**
 * Real-Jujutsu coverage for the Commits panel in a jj session: the history
 * rail (`listJjCommitHistory`), the description card (`getJjCommitDiffInfo`),
 * and the `jj-commit:<commit id>` diff family through the jj provider.
 *
 * Fakes cannot catch what these guard, because each lives in what the real
 * `jj` binary accepts and returns: the template fields, the first-parent
 * revsets, and the merge semantics of `jj diff`.
 *
 * Skipped when `jj` is not installed (CI runners do not ship it).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { GitCommandResult, ReviewGitRuntime } from "./review-core";
import type { ReviewJjRuntime } from "./jj-core";
import { createGitProvider, createJjProvider, createVcsApi } from "./vcs-core";
import { getJjCommitDiffInfo, listJjCommitHistory, resolveJjCommitRailBase } from "./commit-history";
import { canonicalizeJjCommitDiffType } from "./jj-core";

function hasJj(): boolean {
  try {
    return Bun.spawnSync(["jj", "--version"], { stdout: "pipe", stderr: "pipe" }).exitCode === 0;
  } catch {
    return false;
  }
}

const jjRuntime: ReviewJjRuntime = {
  async runJj(args, options): Promise<GitCommandResult> {
    const result = Bun.spawnSync(["jj", ...args], { cwd: options?.cwd, stdout: "pipe", stderr: "pipe" });
    return { stdout: result.stdout.toString(), stderr: result.stderr.toString(), exitCode: result.exitCode };
  },
};

// The git provider is registered only so dispatch is exercised with both
// families present; nothing here reaches it.
const unusedGitRuntime: ReviewGitRuntime = {
  async runGit() { return { stdout: "", stderr: "unused", exitCode: 1 }; },
  async readTextFile() { return null; },
  async getFileInfo() { return null; },
  async readLink() { return null; },
};

const vcs = createVcsApi([createJjProvider(jjRuntime, unusedGitRuntime), createGitProvider(unusedGitRuntime)]);

let workspace = "";

function jj(args: string[]): string {
  const result = Bun.spawnSync(["jj", ...args], { cwd: workspace, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString() || `jj ${args.join(" ")} failed`);
  return result.stdout.toString().trim();
}

const idOf = (revset: string) => jj(["log", "--no-graph", "-r", revset, "-T", "commit_id"]);

/**
 * A pure (non-colocated) jj repo:
 *
 *   base (bookmark main) -> one -> two -\
 *   base ------------------> side -------> merge -> @ (empty, undescribed)
 *
 * `merge`'s FIRST parent is `two`, so the first-parent rail from @ is
 * merge, two, one, base — never `side`.
 */
function initWorkspace(): Record<"base" | "one" | "two" | "side" | "merge", string> {
  workspace = mkdtempSync(join(tmpdir(), "plannotator-jj-commits-"));
  jj(["git", "init", "--no-colocate", "."]);
  jj(["config", "set", "--repo", "user.name", "Rail Test"]);
  jj(["config", "set", "--repo", "user.email", "rail-test@example.invalid"]);

  writeFileSync(join(workspace, "base.txt"), "base\n");
  jj(["commit", "-m", "base"]);
  const base = idOf("@-");
  jj(["bookmark", "create", "main", "-r", base]);

  writeFileSync(join(workspace, "one.txt"), "one\n");
  jj(["commit", "-m", "feature one\n\nWhy it matters, in **markdown**.\n"]);
  const one = idOf("@-");

  writeFileSync(join(workspace, "one.txt"), "one, revised\n");
  jj(["commit", "-m", "feature two"]);
  const two = idOf("@-");

  jj(["new", base]);
  writeFileSync(join(workspace, "side.txt"), "side\n");
  jj(["commit", "-m", "side"]);
  const side = idOf("@-");

  jj(["new", two, side, "-m", "merge"]);
  jj(["new"]);
  const merge = idOf("@-");
  return { base, one, two, side, merge };
}

afterEach(() => {
  if (workspace) rmSync(workspace, { recursive: true, force: true });
  workspace = "";
});

describe("jj Commits rail against a real repository", () => {
  const testIfJj = hasJj() ? test : test.skip;

  testIfJj("walks first parents from @, skips the blank working copy, and marks the base", async () => {
    const ids = initWorkspace();
    const page = await listJjCommitHistory(jjRuntime, "main", workspace, { baseLabel: "main" });
    expect(page).not.toBeNull();
    expect(page!.commits.map((c) => c.sha)).toEqual([ids.merge, ids.two, ids.one, ids.base]);
    expect(page!.commits.map((c) => c.subject)).toEqual(["merge", "feature two", "feature one", "base"]);
    expect(page!.commits.map((c) => c.isPastBase)).toEqual([false, false, false, true]);
    // The blank @ is dropped, so no row is the working copy.
    expect(page!.commits.some((c) => c.isHead)).toBe(false);
    expect(page!.hasMore).toBe(false);
    expect(page!.base).toBe("main");
    expect(page!.commits[0].author).toBe("Rail Test");
    expect(page!.commits[0].authorEmail).toBe("rail-test@example.invalid");
    expect(page!.commits[0].committedAt).toBeGreaterThan(Date.UTC(2020, 0, 1));
  });

  testIfJj("keeps a working copy that has changes and marks it as the head", async () => {
    const ids = initWorkspace();
    writeFileSync(join(workspace, "wip.txt"), "wip\n");
    const page = await listJjCommitHistory(jjRuntime, "main", workspace);
    const head = page!.commits[0];
    expect(head.isHead).toBe(true);
    expect(head.sha).toBe(idOf("@"));
    expect(head.subject).toBe("(no description set)");
    expect(page!.commits[1].sha).toBe(ids.merge);
  });

  testIfJj("keeps a blank MERGE working copy: its first-parent diff is not empty", async () => {
    const ids = initWorkspace();
    // A fresh `jj new A B`: no changes against the auto-merge, no description,
    // yet diffed against its first parent it carries the other side.
    jj(["new", ids.two, ids.side]);
    const page = await listJjCommitHistory(jjRuntime, "main", workspace);
    expect(page!.commits[0].isHead).toBe(true);
    expect(page!.commits[0].sha).toBe(idOf("@"));
    expect(page!.commits[1].sha).toBe(ids.two);
  });

  testIfJj("an opened working copy goes stale on edit, and refresh lands on the new @", async () => {
    initWorkspace();
    writeFileSync(join(workspace, "wip.txt"), "first\n");
    const opened = `jj-commit:${idOf("@")}`;
    const before = await vcs.getVcsDiffFingerprint(opened, "main", workspace);
    expect(before).toEndWith(":visible");
    expect((await vcs.runVcsDiff(opened, "main", workspace)).patch).toContain("+first");

    // jj rewrites @ on the next snapshot; the old id still resolves (hidden).
    writeFileSync(join(workspace, "wip.txt"), "second\n");
    const after = await vcs.getVcsDiffFingerprint(opened, "main", workspace);
    expect(after).not.toBe(before);

    const refreshed = await canonicalizeJjCommitDiffType(jjRuntime, opened, workspace);
    expect(refreshed).toBe(`jj-commit:${idOf("@")}`);
    expect(refreshed).not.toBe(opened);
    expect((await vcs.runVcsDiff(refreshed, "main", workspace)).patch).toContain("+second");
    // A current revision and any other diff type pass through untouched.
    expect(await canonicalizeJjCommitDiffType(jjRuntime, refreshed, workspace)).toBe(refreshed);
    expect(await canonicalizeJjCommitDiffType(jjRuntime, "jj-current", workspace)).toBe("jj-current");
  });

  testIfJj("pages with a before cursor and ends on a cursor that left the rail", async () => {
    const ids = initWorkspace();
    const first = await listJjCommitHistory(jjRuntime, "main", workspace, { limit: 2 });
    expect(first!.commits.map((c) => c.sha)).toEqual([ids.merge, ids.two]);
    expect(first!.hasMore).toBe(true);

    const second = await listJjCommitHistory(jjRuntime, "main", workspace, { limit: 2, before: ids.two });
    expect(second!.commits.map((c) => c.sha)).toEqual([ids.one, ids.base]);
    expect(second!.commits.map((c) => c.isPastBase)).toEqual([false, true]);
    expect(second!.hasMore).toBe(false);

    // `side` is an ancestor of @ but not on the first-parent rail.
    const offRail = await listJjCommitHistory(jjRuntime, "main", workspace, { before: ids.side });
    expect(offRail!.commits).toEqual([]);
    // Not an id at all: refused before it reaches a revset.
    expect(await listJjCommitHistory(jjRuntime, "main", workspace, { before: "main" })).toBeNull();
  });

  testIfJj("draws no divider when the compare target does not resolve", async () => {
    initWorkspace();
    const page = await listJjCommitHistory(jjRuntime, "no-such-bookmark", workspace);
    expect(page!.commits.length).toBe(4);
    expect(page!.commits.every((c) => !c.isPastBase)).toBe(true);
  });

  testIfJj("describes one revision for the commit card, body as markdown", async () => {
    const ids = initWorkspace();
    const info = await getJjCommitDiffInfo(jjRuntime, ids.one, workspace);
    expect(info).toMatchObject({
      sha: ids.one,
      subject: "feature one",
      body: "Why it matters, in **markdown**.",
      author: "Rail Test",
      authorEmail: "rail-test@example.invalid",
    });
    expect(info!.shortSha).toMatch(/^[k-z]{8}$/);
    expect(await getJjCommitDiffInfo(jjRuntime, "0".repeat(39) + "1", workspace)).toBeNull();
  });

  testIfJj("jj-commit diffs a revision against its FIRST parent, merges included", async () => {
    const ids = initWorkspace();
    expect(vcs.vcsOwnsDiffType("jj", `jj-commit:${ids.merge}`)).toBe(true);
    expect(vcs.vcsOwnsDiffType("git", `jj-commit:${ids.merge}`)).toBe(false);
    expect(vcs.vcsOwnsDiffType("jj", `commit:${ids.merge}`)).toBe(false);

    // `jj diff -r merge` would be empty (the merge adds nothing over the
    // auto-merge of its parents); against the first parent it brings `side`.
    const merge = await vcs.runVcsDiff(`jj-commit:${ids.merge}`, "main", workspace);
    expect(merge.error).toBeUndefined();
    expect(merge.patch).toContain("side.txt");
    expect(merge.patch).not.toContain("one.txt");
    expect(merge.label).toContain("merge");

    const two = await vcs.runVcsDiff(`jj-commit:${ids.two}`, "main", workspace);
    expect(two.patch).toContain("+one, revised");
    const contents = await vcs.getVcsFileContentsForDiff(`jj-commit:${ids.two}`, "main", "one.txt", undefined, workspace);
    expect(contents).toEqual({ oldContent: "one\n", newContent: "one, revised\n" });

    // A revision whose parent is the virtual root has no old side.
    const root = await vcs.getVcsFileContentsForDiff(`jj-commit:${ids.base}`, "main", "base.txt", undefined, workspace);
    expect(root).toEqual({ oldContent: null, newContent: "base\n" });

    const fingerprint = await vcs.getVcsDiffFingerprint(`jj-commit:${ids.two}`, "main", workspace);
    expect(fingerprint).toBe(`jj:jj-commit:${ids.two}:visible`);
  });
});

describe("resolveJjCommitRailBase", () => {
  const lineBase = {
    kind: "resolved" as const,
    revision: { commitId: "a".repeat(40), bookmarks: ["main@origin"], subject: "base" },
  };

  test("labels the resolved line base by its bookmark", () => {
    expect(resolveJjCommitRailBase("a".repeat(40), { defaultBranch: "a".repeat(40), jjLineBase: lineBase }))
      .toEqual({ target: "a".repeat(40), label: "main@origin" });
  });

  test("an evolution entry is not a line base: the context default stands in", () => {
    const context = {
      defaultBranch: "a".repeat(40),
      jjLineBase: lineBase,
      jjEvologs: [{ commitId: "b".repeat(12), description: "now" }, { commitId: "c".repeat(12), description: "before" }],
    };
    expect(resolveJjCommitRailBase("c".repeat(12), context).target).toBe("a".repeat(40));
  });

  test("a picked bookmark keeps its name; an unlabeled commit id is shortened", () => {
    expect(resolveJjCommitRailBase("feature", { defaultBranch: "trunk()" })).toEqual({ target: "feature", label: "feature" });
    expect(resolveJjCommitRailBase("d".repeat(40), { defaultBranch: "trunk()" }).label).toBe("d".repeat(12));
  });
});
