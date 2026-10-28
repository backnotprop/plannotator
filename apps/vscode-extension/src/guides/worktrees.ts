/**
 * When a pull request's worktree may go. A PR guide, a PR draft, the live run
 * and the open reader each read one worktree under the extension's storage;
 * deleting a guide or a draft removes it only when none of the others still
 * reads it. No `vscode` import.
 */

import { listGuides } from "@plannotator/shared/guide-store";
import { guideWorktreePath } from "./reader-model";
import { pullRequestWorktreePath, removePullRequestWorktree } from "./sources/github";
import type { Runner } from "./sources/runner";
import { listDraftRecords, loadSavedGuide, type DraftRecord, type LoadedGuide } from "./store";

/** What reads a worktree besides the saved guides and drafts on disk. */
export interface WorktreeUsers {
  storageDir: string;
  /** The live run's head root. */
  liveRunHeadRoot?: string | null;
  /** The open reader's head root. */
  readerGitRoot?: string | null;
  /** Guides kept in memory (guide history off). */
  sessionGuides?: Iterable<LoadedGuide>;
}

/** The worktree a PR draft reads, or null for a local-changes draft. */
export function draftWorktreePath(record: DraftRecord, storageDir: string): string | null {
  const { source } = record;
  if (source.kind !== "pr" || !source.pr) return null;
  return pullRequestWorktreePath(storageDir, record.repoKey, source.pr.number, source.headSha);
}

/** Whether a guide, a draft, the live run or the open reader other than `except` reads this worktree. */
export function pullRequestWorktreeInUse(
  repoKey: string,
  path: string,
  users: WorktreeUsers,
  except: { guideId?: string; draftId?: string } = {},
): boolean {
  if (users.liveRunHeadRoot === path) return true;
  if (users.readerGitRoot === path) return true;
  for (const d of listDraftRecords(repoKey)) {
    if (d.id !== except.draftId && draftWorktreePath(d, users.storageDir) === path) return true;
  }
  for (const { id } of listGuides(repoKey)) {
    if (id === except.guideId) continue;
    const other = loadSavedGuide(repoKey, id);
    if (other && guideWorktreePath(other, users.storageDir) === path) return true;
  }
  for (const other of users.sessionGuides ?? []) {
    if (other.id !== except.guideId && guideWorktreePath(other, users.storageDir) === path) return true;
  }
  return false;
}

/** After a PR draft is discarded: remove its worktree unless something else still reads it. */
export async function removeDraftWorktree(runner: Runner, record: DraftRecord, users: WorktreeUsers): Promise<boolean> {
  const wt = draftWorktreePath(record, users.storageDir);
  if (!wt || pullRequestWorktreeInUse(record.repoKey, wt, users, { draftId: record.id })) return false;
  return removePullRequestWorktree(runner, record.source.repoRoot, wt, users.storageDir);
}
