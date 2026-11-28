/**
 * Files of the person's that a reply draft did not take: a draft held for a linked computer while it slept named a
 * file that computer swept since (an upload is kept a day there), so its draft landed without it
 * (packages/server/inbox-machine-drafts.ts, `not_landed.files`). Never dropped unsaid: the box shows each as a refused
 * tile, in the words a tile uses for a file that could not be added, until the person removes it (its ×) or writes
 * again (then the read no longer names it; a tile already shown stays until removed). Only the window's memory.
 */
import type { InboxDraftFile } from '@plannotator/core/inbox-types';

/** A refused tile's words for a file that could not be added (ComposeFiles.tsx, as an attach that failed says). */
export const FILE_NOT_ADDED = 'Not attached: that file could not be added.';

const lost = new Map<string, readonly InboxDraftFile[]>();
/** Removed by the person (a tile's ×): never shown again in this page. */
const dismissed = new Set<string>();

/** What the thread's last draft read said its draft did not take (none: nothing). */
export function noteLostDraftFiles(threadId: string, files: readonly InboxDraftFile[] | undefined): void {
  const left = (files ?? []).filter((file) => !dismissed.has(file.upload_id));
  if (left.length > 0) lost.set(threadId, left);
  else lost.delete(threadId);
}

/** The thread's files its draft did not take, for the box's tiles. */
export function lostDraftFilesOf(threadId: string): readonly InboxDraftFile[] {
  return lost.get(threadId) ?? [];
}

/** The person removed the tile: it is not shown again. */
export function dismissLostDraftFile(uploadId: string): void {
  dismissed.add(uploadId);
  for (const [threadId, files] of lost) noteLostDraftFiles(threadId, files);
}

/** DOM tests: a new page. */
export function resetLostDraftFilesForTests(): void {
  lost.clear();
  dismissed.clear();
}
