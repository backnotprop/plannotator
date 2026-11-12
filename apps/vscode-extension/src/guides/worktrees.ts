import { listGuides } from "@plannotator/shared/guide-store";
import { guideWorktreePath } from "./reader-model";
import { pullRequestWorktreePath, removePullRequestWorktree } from "./sources/github";
import type { Runner } from "./sources/runner";
import { listDraftRecords, loadSavedGuide, type DraftRecord, type LoadedGuide } from "./store";

export interface WorktreeUsers {
  storageDir: string;
  liveRunHeadRoot?: string | null;
  readerGitRoot?: string | null;
  sessionGuides?: Iterable<LoadedGuide>;
}

export function draftWorktreePath(record: DraftRecord, storageDir: string): string | null {
  const { source } = record;
  if (source.kind !== "pr" || !source.pr) return null;
  return pullRequestWorktreePath(storageDir, record.repoKey, source.pr.number, source.headSha);
}

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

export async function removeDraftWorktree(runner: Runner, record: DraftRecord, users: WorktreeUsers): Promise<boolean> {
  const wt = draftWorktreePath(record, users.storageDir);
  if (!wt || pullRequestWorktreeInUse(record.repoKey, wt, users, { draftId: record.id })) return false;
  return removePullRequestWorktree(runner, record.source.repoRoot, wt, users.storageDir);
}
