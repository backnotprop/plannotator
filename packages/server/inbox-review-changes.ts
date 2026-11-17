/**
 * New review's change summary ("3 files +42 -7"): the size of a project's local changes, read with the same git diffs
 * `plannotator review` shows, so the box and the review agree. Read only. A named `branch` (Branch reviews' safety net)
 * is that branch's whole diff from its merge base with the default branch, checked out or not.
 */

import { inboxReviewPatchSize, type InboxReviewChanges, type InboxReviewChangesAnswer } from "@plannotator/core/inbox-types";
import { getCurrentBranch, getDefaultBranch, runGitDiff, type DiffType } from "@plannotator/shared/review-core";
import { branchBaseName, offlineGit, readBranchDiff } from "./inbox-branch-reports";
import { runtime } from "./git";

const DIFF_OF: Record<InboxReviewChanges, DiffType> = { uncommitted: "uncommitted", last: "last-commit", branch: "branch" };

export async function readInboxReviewChanges(root: string, changes: InboxReviewChanges, branch: string | null = null): Promise<InboxReviewChangesAnswer> {
  const inside = await runtime.runGit(["rev-parse", "--is-inside-work-tree"], { cwd: root });
  if (inside.exitCode !== 0) return { git: false, files: 0, additions: 0, deletions: 0, branch: null, base: null };
  if (branch) {
    // Branch reviews' reads keep off the network and are short (`offlineGit`), as every other one of theirs.
    const base = branchBaseName(await getDefaultBranch(offlineGit(runtime), root));
    const patch = await readBranchDiff(runtime, root, base, `refs/heads/${branch}`).catch(() => "");
    return { git: true, ...inboxReviewPatchSize(patch), branch, base };
  }
  const [current, base] = await Promise.all([getCurrentBranch(runtime, root), getDefaultBranch(runtime, root)]);
  const { patch } = await runGitDiff(runtime, DIFF_OF[changes], base, root);
  return { git: true, ...inboxReviewPatchSize(patch), branch: current || null, base: base.replace(/^origin\//, "") || null };
}
