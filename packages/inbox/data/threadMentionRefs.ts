/**
 * Which thread a mention names (approval "inbox-drag-threads", piece 1): its title, project and state, read from what
 * the window already holds (the list, a thread read) and, for a thread it holds nothing of (an archived one, a link
 * pasted from elsewhere), one read of that thread. Never a write.
 */
import type { QueryClient } from '@tanstack/react-query';
import { displayInboxSubject, type InboxListRow, type InboxThread } from '@plannotator/core/inbox-types';
import { inboxThreadMentionTitle, isInboxThreadMentionId, type InboxThreadMentionRef } from '@plannotator/core/inbox-thread-mention';
import { machineOf } from '../inboxUrl';
import { heldList } from './queries/list';
import { heldThread, readThread } from './queries/thread';

/** How long a pasted link's thread read may take before the paste goes in as plain words. */
const READ_MS = 4000;

type Titled = Pick<InboxListRow, 'thread_id' | 'thread_name' | 'subject' | 'resolved_at'> & { project?: { name: string } | null; machine?: string };

/** The title the list shows for a thread: its name, else its subject. */
export function mentionTitleOf(row: Pick<InboxListRow, 'thread_name' | 'subject'>): string {
  return inboxThreadMentionTitle(row.thread_name?.trim() ? row.thread_name : (displayInboxSubject(row.subject) ?? 'Untitled thread'));
}

/** A list row (or a thread's own record) as a mention. */
export function mentionRefOf(row: Titled): InboxThreadMentionRef {
  return {
    id: row.thread_id,
    title: mentionTitleOf(row),
    project: row.project?.name ?? null,
    ...(row.resolved_at ? { archived: true } : {}),
    ...(row.machine || machineOf(row.thread_id) ? { elsewhere: true } : {}),
  };
}

/** Every row the list holds now (its sections and the snoozed), by thread id. */
function listRows(client: QueryClient): Map<string, InboxListRow> {
  const list = heldList(client);
  const rows = new Map<string, InboxListRow>();
  if (!list) return rows;
  for (const section of list.sections) for (const row of section.threads) rows.set(row.thread_id, row);
  for (const row of list.snoozed ?? []) if (!rows.has(row.thread_id)) rows.set(row.thread_id, row);
  return rows;
}

const ofThread = (thread: InboxThread, row: InboxListRow | null | undefined): InboxThreadMentionRef =>
  mentionRefOf(row ?? { thread_id: thread.thread_id, thread_name: thread.thread_name, subject: thread.subject, resolved_at: thread.resolved_at, project: thread.project });

/** Rows a drag or a menu just named (an Archived group's row is in no list read): the latest few, by id. */
const noted = new Map<string, InboxThreadMentionRef>();
export function noteMentionRefs(refs: readonly InboxThreadMentionRef[]): void {
  for (const ref of refs) {
    noted.delete(ref.id);
    noted.set(ref.id, ref);
  }
  for (const id of [...noted.keys()].slice(0, Math.max(0, noted.size - 200))) noted.delete(id);
}

/** The thread as a mention from what the window holds now, or null when it holds nothing of it. */
export function knownMentionRef(client: QueryClient, id: string): InboxThreadMentionRef | null {
  const row = listRows(client).get(id);
  if (row) return mentionRefOf(row);
  const named = noted.get(id);
  if (named) return named;
  const held = heldThread(client, id);
  return held ? ofThread(held.thread, held.row) : null;
}

/** The thread as a mention: what the window holds, else one read of it; null when it is no thread of this Inbox. */
export async function resolveMentionRef(client: QueryClient, id: string): Promise<InboxThreadMentionRef | null> {
  if (!isInboxThreadMentionId(id)) return null;
  const known = knownMentionRef(client, id);
  if (known) return known;
  try {
    const read = await readThread(id, READ_MS);
    return read.thread?.thread_id === id ? ofThread(read.thread, read.row) : null;
  } catch {
    return null;
  }
}
