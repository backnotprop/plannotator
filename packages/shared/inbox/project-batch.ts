/**
 * The project menu's batches (design record "inbox-project-menu", approved
 * 2026-10-14): "Mark all as read" and "Archive all" on one project, and their
 * Undo. Each is a loop over the store's own per-thread methods (`markRead`,
 * `resolveThread`), so the store stays append-only and gets no new record
 * kind: every line a batch writes is a line the single action writes. The
 * store is synchronous in one process, so a batch runs with nothing
 * interleaved.
 *
 * Which threads a batch takes is the window's own rule for the single
 * action, read from each thread's list row:
 *   - Mark all as read: every thread Mark read is offered on
 *     (`inboxRowOffersMarkRead`: something waits on the person, open or come
 *     back from the archive).
 *   - Archive all: every thread the window's list holds (not archived). An
 *     open thread is resolved; a thread that came back from the archive gets
 *     Mark read instead, which sends it back there (resolving it again would
 *     do nothing).
 *
 * The Undo takes the thread ids the batch answered with, never "the
 * project", so it can only touch what the batch touched. A thread that no
 * longer belongs to the project, or refuses (archived since by another
 * hand), is skipped and named in `skipped`.
 */

import { inboxRowOffersMarkRead, type InboxListRow } from "@plannotator/core/inbox-types";
import { inboxRowArchived } from "./list";
import { InboxError } from "./schema";
import type { InboxStore } from "./store";

export interface ProjectReadBatch {
  /** The threads marked read, in list order. */
  read: string[];
  /**
   * The loop stopped partway (a write failed): the threads above are the
   * ones it changed, which the Undo and the set-aside notes still cover; the
   * rest did not change. Absent when every thread was done.
   */
  error?: string;
}

export interface ProjectArchiveBatch {
  /** The open threads resolved. */
  resolved: string[];
  /** The threads that came back from the archive, marked read (back to the archive). */
  read: string[];
  /** As for ProjectReadBatch: the loop stopped partway. */
  error?: string;
}

/** Why a write in the loop failed, for the server's log (never the page). */
function failure(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface ProjectUndoResult {
  /** The threads the Undo changed or found already as it leaves them. */
  done: string[];
  /** Named but not this project's, or refused by the store (left as they are). */
  skipped: string[];
}

function projectRows(store: InboxStore, projectId: string): InboxListRow[] {
  if (!store.project(projectId)) throw new InboxError("project_not_found", `No project ${projectId}.`);
  return store.listRows({ projectId });
}

/** Mark all as read: `markRead(t, true)` for every thread single Mark read is offered on. */
export function markProjectRead(store: InboxStore, projectId: string): ProjectReadBatch {
  const read: string[] = [];
  for (const row of projectRows(store, projectId)) {
    if (!inboxRowOffersMarkRead(row)) continue;
    try {
      store.markRead(row.thread_id, true);
    } catch (error) {
      // A failed write stops the batch; what was done stays done, and is answered so it can be undone.
      return { read, error: failure(error) };
    }
    read.push(row.thread_id);
  }
  return { read };
}

/** Archive all: resolve every listed open thread; Mark read on one that came back. */
export function archiveProject(store: InboxStore, projectId: string): ProjectArchiveBatch {
  const resolved: string[] = [];
  const read: string[] = [];
  for (const row of projectRows(store, projectId)) {
    if (inboxRowArchived(row)) continue;
    try {
      if (row.resolved_at !== null) {
        store.markRead(row.thread_id, true);
        read.push(row.thread_id);
      } else {
        store.resolveThread(row.thread_id, true);
        resolved.push(row.thread_id);
      }
    } catch (error) {
      return { resolved, read, error: failure(error) };
    }
  }
  return { resolved, read };
}

/** The thread, when it is one of this project's threads (its root). */
function ownThread(store: InboxStore, projectId: string, threadId: string): boolean {
  const root = store.message(threadId);
  return root !== null && root.thread_id === threadId && root.project_id === projectId;
}

function each(store: InboxStore, projectId: string, threadIds: readonly string[], write: (threadId: string) => void, out: ProjectUndoResult): void {
  for (const threadId of new Set(threadIds)) {
    if (!ownThread(store, projectId, threadId)) {
      out.skipped.push(threadId);
      continue;
    }
    try {
      write(threadId);
      out.done.push(threadId);
    } catch (error) {
      if (!(error instanceof InboxError)) throw error;
      out.skipped.push(threadId);
    }
  }
}

/** Undo of Mark all as read: `markRead(t, false)` for exactly the named threads. */
export function unmarkProjectRead(store: InboxStore, projectId: string, threadIds: readonly string[]): ProjectUndoResult {
  if (!store.project(projectId)) throw new InboxError("project_not_found", `No project ${projectId}.`);
  const out: ProjectUndoResult = { done: [], skipped: [] };
  each(store, projectId, threadIds, (id) => store.markRead(id, false), out);
  return out;
}

/** Undo of Archive all: unarchive the resolved threads, move back the ones sent back by Mark read. */
export function unarchiveProject(store: InboxStore, projectId: string, batch: ProjectArchiveBatch): ProjectUndoResult {
  if (!store.project(projectId)) throw new InboxError("project_not_found", `No project ${projectId}.`);
  const out: ProjectUndoResult = { done: [], skipped: [] };
  each(store, projectId, batch.resolved, (id) => store.resolveThread(id, false), out);
  each(store, projectId, batch.read, (id) => store.markRead(id, false), out);
  return out;
}
