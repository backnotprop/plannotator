/**
 * After records arrive on the event stream, the window reads the list, the
 * drafts and the decisions again, and reads the open thread again only when
 * those records can change what the thread shows (perf study, item 4a') and
 * the cache could not apply them in place (data/apply/stream.ts: a record the
 * held thread took is `applied`, and owes no read of the thread).
 *
 * What the open thread's read carries, and what changes it:
 *  - its messages, their questions and their annotations: a message, question
 *    or annotation record of that thread (a question's thread is its
 *    message's: the server names it, `thread_id`);
 *  - its project (name, label, the project it was combined into): any project
 *    record, of any project (a new project can change another's label);
 *  - its project's repo, which the server learns off the record path: while
 *    it is not known yet (no repo, and no `repo_known`: a folder with no
 *    `origin` is known once resolved), every record reads the thread; and once
 *    the last read is older than the repo's freshness (`INBOX_REPO_TTL_MS`),
 *    the next record reads it, as before, so a changed `origin` reaches its links;
 *  - its row (delivery, snooze, unsent work), which the window shows only
 *    when the list has no row for it (an archived thread): then every record
 *    reads the thread, as before;
 *  - a thread on another machine: its records come in `machine` frames, and
 *    every record here still reads it, as before.
 * A record it cannot place (a malformed frame, a kind this build does not
 * know, a read owed with no record) reads the thread too.
 *
 * A question record that only says what this window's own save already
 * brought back (`ownSaves.ts`: its revision is no newer than the save's
 * answer) is noted apart: the pane drew that answer when the save landed, so
 * it reads neither the thread nor its files. It still owes the list, the
 * decisions and the drafts, which show the pick too. The thread is read as
 * before when the list has no row for it or it is another machine's.
 *
 * A launched thread is read on every record too: its run line ("Starting
 * Pi again…") moves with no record of its own.
 *
 * A read the records do not need is replaced by what it did besides: once
 * the list read lands, the thread is read after all when that list no longer
 * has it (it was deleted elsewhere: no record says so). Its files (and the
 * comments waiting for a Send, which ride with them) are read when a record
 * can have moved them (`files`, data/apply/record.ts `recordMovesFiles`): a
 * comment added, edited or removed anywhere, or the agent at work (a new
 * message, its read of the person's reply), so a file it edited or deleted on
 * disk shows, as when every record read the thread. A message that brings files
 * has the pane read them by itself (data/queries/files.ts), and so does the
 * window coming back into focus. A look, Mark read, an archive or a pick reads none.
 */
import { INBOX_REPO_TTL_MS, type InboxListRow, type InboxListSection } from '@plannotator/core/inbox-types';
import type { InboxEvent } from './api';
import { listGroups } from './held';

/** Whether a list read has a row for the thread (any section, the snoozed ones too), as the window's header reads it. */
export function listsThread(list: { sections: readonly InboxListSection[]; snoozed?: readonly InboxListRow[] } | null | undefined, threadId: string): boolean {
  return !!list && listGroups(list).some((group) => group.threads.some((row) => row.thread_id === threadId));
}

/** The records of one pause (the 80 ms the window waits before it reads). */
export interface RecordBatch {
  /** A record that can change any thread, or one that could not be placed. */
  any: boolean;
  /** The threads the records belong to that the cache could not apply them to (a read shows them). */
  threads: Set<string>;
  /** The threads whose records the cache applied in place: no read of the thread, only what a read did besides. */
  applied: Set<string>;
  /** The threads of records that only echo this window's own question saves (not in `threads` for them alone). */
  own: Set<string>;
  /** The threads of records that can change their files or waiting comments (see the header). */
  files: Set<string>;
}

export function newRecordBatch(): RecordBatch {
  return { any: false, threads: new Set(), applied: new Set(), own: new Set(), files: new Set() };
}

/** Note a record of this window's own question save, already drawn from the save's answer. */
export function noteOwnRecord(batch: RecordBatch, threadId: string): void {
  batch.own.add(threadId);
}

/** The batch holds only echoes of this window's own saves: nothing another window, device or agent did. */
export function onlyOwnRecords(batch: RecordBatch): boolean {
  return !batch.any && batch.threads.size === 0 && batch.applied.size === 0 && batch.own.size > 0;
}

/**
 * Note one record in the batch. `null`: a malformed frame, or a read owed with no record (a pick save's). `applied`:
 * the cache took it into the held thread in place. `files`: it can have moved the thread's files or waiting comments
 * (data/apply/record.ts `recordMovesFiles`).
 */
export function noteRecord(batch: RecordBatch, event: InboxEvent | null, applied = false, files = false): void {
  const threadId = event ? threadOfRecord(event) : null;
  if (threadId === null) batch.any = true;
  else if (applied) batch.applied.add(threadId);
  else batch.threads.add(threadId);
  if (threadId !== null && files) batch.files.add(threadId);
}

/** The one thread a record can change, or null when it can change any (or cannot be placed). */
export function threadOfRecord(event: InboxEvent): string | null {
  const id = (value: unknown) => (typeof value === 'string' && value !== '' ? value : null);
  switch (event.kind) {
    case 'message':
      return id(event.message?.thread_id);
    case 'question':
      // Absent from an older Inbox, null when its message is gone: not placed.
      return id(event.thread_id);
    case 'annotation':
      return id(event.annotation?.thread_id);
    case 'steps':
    case 'thread_pull':
      return id(event.thread_id);
    // A project (a rename, a combine, a label any thread's header reads), a Board card or initiative (the window
    // hands those to the Board before this): any thread.
    case 'project':
    case 'card':
    case 'initiative':
      return null;
    default: {
      // A kind this build does not know (a newer Inbox's): any thread. A kind added without a decision fails here.
      const unknown: never = event;
      void unknown;
      return null;
    }
  }
}

/** The open thread as the window holds it when the pause ends. */
export interface OpenThreadState {
  threadId: string;
  /** On another machine (`machineOf`). */
  remote: boolean;
  /** Its last read that landed, or null (none yet since it opened). A root with `launch`: started from the Inbox. */
  loaded: { thread_id: string; project: { repo?: unknown; repo_known?: true }; messages?: readonly { launch?: unknown }[] } | null;
  /** When that read landed (ms, the window's clock), and now. */
  loadedAt: number;
  now: number;
  /** That read stands: no failure, wait or refusal shown for it. */
  settled: boolean;
  /** The latest list has its row (the header reads the list's row, not the thread read's). */
  listed: boolean;
}

/**
 * `thread`: read the open thread again (its files with it). `files`: only its files, then the list check. `none`:
 * only the list check (see the header).
 */
export type OpenThreadRead = 'thread' | 'files' | 'none';

export function openThreadRead(batch: RecordBatch, open: OpenThreadState): OpenThreadRead {
  if (batch.any || batch.threads.has(open.threadId)) return 'thread';
  if (onlyOwnRecords(batch) && batch.own.has(open.threadId)) return open.remote || !open.listed ? 'thread' : 'none';
  if (open.remote || !open.settled || !open.listed) return 'thread';
  // Started from the Inbox: its run line moves with no record.
  if (open.loaded?.messages?.[0]?.launch) return 'thread';
  if (open.loaded?.thread_id !== open.threadId) return 'thread';
  // Not known yet (an older Inbox never says it knows): the next read may bring it.
  if (open.loaded.project.repo == null && open.loaded.project.repo_known !== true) return 'thread';
  // The server refreshes a repo only when a read asks for it after this long: read, as every record did before.
  if (open.now - open.loadedAt > INBOX_REPO_TTL_MS) return 'thread';
  return batch.files.has(open.threadId) ? 'files' : 'none';
}
