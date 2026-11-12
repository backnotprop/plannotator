import { inboxRowOffersMarkRead, type InboxListRow } from "@plannotator/core/inbox-types";
import { inboxRowArchived } from "./list";
import { InboxError } from "./schema";
import type { InboxStore } from "./store";

export interface ProjectReadBatch {
  read: string[];
  looked: string[];
  error?: string;
}

export interface ProjectArchiveBatch {
  resolved: string[];
  read: string[];
  error?: string;
}

function failure(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface ProjectUndoResult {
  done: string[];
  skipped: string[];
}

function projectRows(store: InboxStore, projectId: string): InboxListRow[] {
  if (!store.project(projectId)) throw new InboxError("project_not_found", `No project ${projectId}.`);
  return store.listRows({ projectId });
}

export function markProjectRead(store: InboxStore, projectId: string): ProjectReadBatch {
  const read: string[] = [];
  const looked: string[] = [];
  const snoozed = store.snoozedThreads();
  for (const row of projectRows(store, projectId)) {
    if (snoozed.has(row.thread_id)) continue;
    if (!inboxRowOffersMarkRead(row)) {
      if (store.snoozes().some((entry) => entry.thread_id === row.thread_id)) store.endSnooze(row.thread_id);
      continue;
    }
    try {
      store.markRead(row.thread_id, true);
    } catch (error) {
      return { read, looked, error: failure(error) };
    }
    ((row.read_at ?? null) === null ? read : looked).push(row.thread_id);
  }
  return { read, looked };
}

export function archiveProject(store: InboxStore, projectId: string): ProjectArchiveBatch {
  const resolved: string[] = [];
  const read: string[] = [];
  const snoozed = store.snoozedThreads();
  for (const row of projectRows(store, projectId)) {
    if (inboxRowArchived(row) || snoozed.has(row.thread_id)) continue;
    try {
      if (row.resolved_at !== null) {
        store.markRead(row.thread_id, true);
        read.push(row.thread_id);
      } else {
        store.resolveThread(row.thread_id, true, "person");
        resolved.push(row.thread_id);
      }
    } catch (error) {
      return { resolved, read, error: failure(error) };
    }
  }
  return { resolved, read };
}

function ownThread(store: InboxStore, projectId: string, threadId: string): boolean {
  const root = store.message(threadId);
  return root !== null && root.thread_id === threadId && store.sameProject(root.project_id, projectId);
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

export function unmarkProjectRead(store: InboxStore, projectId: string, threadIds: readonly string[], looked: readonly string[] = []): ProjectUndoResult {
  if (!store.project(projectId)) throw new InboxError("project_not_found", `No project ${projectId}.`);
  const out: ProjectUndoResult = { done: [], skipped: [] };
  each(store, projectId, threadIds, (id) => store.markRead(id, false), out);
  each(store, projectId, looked, (id) => store.markUnread(id), out);
  return out;
}

export function unarchiveProject(store: InboxStore, projectId: string, batch: ProjectArchiveBatch): ProjectUndoResult {
  if (!store.project(projectId)) throw new InboxError("project_not_found", `No project ${projectId}.`);
  const out: ProjectUndoResult = { done: [], skipped: [] };
  each(store, projectId, batch.resolved, (id) => store.resolveThread(id, false), out);
  each(store, projectId, batch.read, (id) => store.markRead(id, false), out);
  return out;
}
