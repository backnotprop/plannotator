/**
 * What the person deleted in this window (Settings → Storage: a thread, or a project with its threads). A thread on
 * screen is never dropped by a re-read that answers 404 (panes/paneReads.ts: what is open stays open), except one the
 * person deleted here themselves: that one goes as before.
 */
import type { InboxThread } from '@plannotator/core/inbox-types';

const threads = new Set<string>();
const projects = new Set<string>();

export function noteDeletedHere(what: { thread?: string; project?: string }): void {
  if (what.thread) threads.add(what.thread);
  if (what.project) projects.add(what.project);
}

/** The person deleted this thread, or its project, in this window. */
export function deletedHere(thread: Pick<InboxThread, 'thread_id' | 'project'>): boolean {
  return threads.has(thread.thread_id) || projects.has(thread.project.id);
}
