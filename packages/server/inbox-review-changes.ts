/**
 * New review's change summary ("3 files +42 -7"): the size of a project's local changes, read with the same git diffs
 * `plannotator review` shows, so the box and the review agree. Read only.
 */

import { inboxReviewPatchSize, type InboxReviewChanges, type InboxReviewChangesAnswer } from "@plannotator/core/inbox-types";
import { getCurrentBranch, getDefaultBranch, runGitDiff, type DiffType } from "@plannotator/shared/review-core";
import { runtime } from "./git";

const DIFF_OF: Record<InboxReviewChanges, DiffType> = { uncommitted: "uncommitted", last: "last-commit", branch: "branch" };

export async function readInboxReviewChanges(root: string, changes: InboxReviewChanges): Promise<InboxReviewChangesAnswer> {
  const inside = await runtime.runGit(["rev-parse", "--is-inside-work-tree"], { cwd: root });
  if (inside.exitCode !== 0) return { git: false, files: 0, additions: 0, deletions: 0, branch: null, base: null };
  const [branch, base] = await Promise.all([getCurrentBranch(runtime, root), getDefaultBranch(runtime, root)]);
  const { patch } = await runGitDiff(runtime, DIFF_OF[changes], base, root);
  return { git: true, ...inboxReviewPatchSize(patch), branch: branch || null, base: base.replace(/^origin\//, "") || null };
}
