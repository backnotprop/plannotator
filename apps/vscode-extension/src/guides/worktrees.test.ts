/**
 * Discarding a PR draft removes its worktree under the same rule deleting a
 * guide uses: unless another guide, a draft, the live run or the open reader
 * still reads it. A real git repository and real worktrees in a temp dir.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildGuideSnapshot } from "@plannotator/core/guide-format";
import { createGuideDraft } from "./core/adapter";
import { pullRequestWorktreePath } from "./sources/github";
import { defaultRunner } from "./sources/runner";
import { deleteDraftRecord, loadSavedGuide, saveDraftRecord, saveFinishedGuide, snapshotSource, type DraftRecord, type ReviewSourceRecord } from "./store";
import { removeDraftWorktree } from "./worktrees";

const patch = ["diff --git a/a.ts b/a.ts", "new file mode 100644", "--- /dev/null", "+++ b/a.ts", "@@ -0,0 +1,1 @@", "+a", ""].join("\n");

let work: string;
let repoRoot: string;
let storageDir: string;
let headSha: string;
let n = 0;

const git = (args: string[], cwd = repoRoot) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } }).trim();

beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), "pn-guides-wt-"));
  repoRoot = join(work, "repo");
  storageDir = join(work, "storage");
  mkdirSync(repoRoot, { recursive: true });
  git(["init", "-q"]);
  writeFileSync(join(repoRoot, "a.ts"), "a\n");
  git(["add", "a.ts"]);
  git(["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "a"]);
  headSha = git(["rev-parse", "HEAD"]);
});

afterAll(() => {
  rmSync(work, { recursive: true, force: true });
});

/** A fresh repo key with a real worktree at the PR's path. */
function prWorktree(): { repoKey: string; path: string; source: ReviewSourceRecord } {
  const repoKey = `test__wt-${++n}`;
  const path = pullRequestWorktreePath(storageDir, repoKey, 482, headSha);
  mkdirSync(join(path, ".."), { recursive: true });
  git(["worktree", "add", "-q", "--detach", path, headSha]);
  const source: ReviewSourceRecord = {
    kind: "pr",
    repoRoot,
    headRoot: path,
    repoName: "repo",
    label: "PR #482",
    headSha,
    baseSha: headSha,
    baseLabel: "main",
    pr: { number: 482, url: "https://github.com/o/repo/pull/482", title: "T" },
    worktreePath: path,
  };
  return { repoKey, path, source };
}

function draft(repoKey: string, source: ReviewSourceRecord): DraftRecord {
  const record: DraftRecord = {
    v: 1,
    id: `draft-${Date.now()}-${++n}`,
    repoKey,
    createdAt: 1,
    updatedAt: 1,
    status: "stopped",
    source,
    agent: { id: "claude-code", label: "Claude Code" },
    draft: createGuideDraft({ review: { rawPatch: patch, gitRef: "PR #482", source: snapshotSource(source) }, now: new Date(1).toISOString() }),
  };
  saveDraftRecord(record);
  return record;
}

/** What the controller does on Discard: delete the record, then the worktree unless something reads it. */
async function discard(record: DraftRecord, extra: { liveRunHeadRoot?: string; readerGitRoot?: string } = {}): Promise<boolean> {
  deleteDraftRecord(record.repoKey, record.id);
  return removeDraftWorktree(defaultRunner, record, { storageDir, ...extra });
}

describe("discarding a PR draft", () => {
  it("removes its worktree when nothing else reads it", async () => {
    const { repoKey, path, source } = prWorktree();
    const record = draft(repoKey, source);
    expect(await discard(record)).toBe(true);
    expect(existsSync(path)).toBe(false);
    expect(git(["worktree", "list"])).not.toContain(path);
  });

  it("keeps the worktree while another draft of the same PR head reads it", async () => {
    const { repoKey, path, source } = prWorktree();
    const record = draft(repoKey, source);
    draft(repoKey, source);
    expect(await discard(record)).toBe(false);
    expect(existsSync(path)).toBe(true);
  });

  it("keeps the worktree while a saved guide of the same PR head reads it", async () => {
    const { repoKey, path, source } = prWorktree();
    const record = draft(repoKey, source);
    const snapshot = buildGuideSnapshot({
      guide: { title: "T", intent: "I", sections: [{ title: "One", overview: "o", diffs: [{ file: "a.ts" }] }] },
      reviewed: [],
      review: { rawPatch: patch, gitRef: "PR #482", source: snapshotSource(source) },
    });
    const id = saveFinishedGuide({ repoKey, snapshot, source, agent: { id: "claude-code", label: "Claude Code" }, focus: {} });
    expect(loadSavedGuide(repoKey, id)).not.toBeNull();
    expect(await discard(record)).toBe(false);
    expect(existsSync(path)).toBe(true);
  });

  it("keeps the worktree while the live run or the open reader reads it", async () => {
    const { repoKey, path, source } = prWorktree();
    expect(await discard(draft(repoKey, source), { liveRunHeadRoot: path })).toBe(false);
    expect(await discard(draft(repoKey, source), { readerGitRoot: path })).toBe(false);
    expect(existsSync(path)).toBe(true);
  });

  it("does nothing for a local-changes draft", async () => {
    const repoKey = `test__wt-${++n}`;
    const record = draft(repoKey, { kind: "local", repoRoot, headRoot: repoRoot, repoName: "repo", label: "Local changes", headSha, baseSha: headSha, baseLabel: "main" });
    expect(await discard(record)).toBe(false);
    expect(existsSync(repoRoot)).toBe(true);
  });
});
