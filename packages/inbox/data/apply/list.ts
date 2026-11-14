/**
 * One live-stream record applied to the list held, in place (pure: no cache, no React).
 *
 * A row is worked out by the server (its section, unread, counts, preview), and a record does not carry it, so the
 * list read after the record still brings each row. What a record says exactly, the list takes at once:
 *  - its thread archived (a later line of the root, now resolved): the row leaves the list (the owner's ruling: a
 *    thread archived anywhere leaves every window's list at once);
 *  - its thread renamed (a later line of the root with another name): the row's name, in its section, the snoozed
 *    and the pins (the sidebar's Pinned row and the starred pills change with the list row);
 *  - its only message taken back (the root's line with `taken_back_at`): the row leaves the list, the snoozed and the pins.
 * Anything else (a new message, a look, an unarchive, a question) waits for that read.
 *
 * The list held takes the record's seq as its cursor, so a list read that left before the record and lands after it
 * is the older one and never puts the row back (`takeListRead`).
 */
import type { InboxListRow, InboxListSection } from '@plannotator/core/inbox-types';
import type { InboxEvent, ListModel } from '../../api';

const withoutThread = (rows: readonly InboxListRow[], threadId: string) => rows.filter((row) => row.thread_id !== threadId);

/** The list as the record leaves it, or null when the record changes nothing the list can take in place. */
export function applyListRecord(list: ListModel, event: InboxEvent): ListModel | null {
  if (event.kind !== 'message' || event.seq <= list.cursor) return null;
  const record = event.message;
  // Only a later line of a thread's root says what happened to the thread itself.
  if (event.first || record.id !== record.thread_id) return null;
  const threadId = record.thread_id;
  const listed = (rows: readonly InboxListRow[] | undefined) => rows?.some((row) => row.thread_id === threadId) ?? false;
  const row = [...list.sections.flatMap((section) => section.threads), ...(list.snoozed ?? [])].find((r) => r.thread_id === threadId);
  const pinned = list.pins?.some((r) => r.thread_id === threadId) ?? false;
  if (!row && !pinned) return null;
  if (record.taken_back_at) {
    const sections: InboxListSection[] = list.sections.map((section) => (listed(section.threads) ? { ...section, threads: withoutThread(section.threads, threadId) } : section));
    return { ...list, cursor: event.seq, sections, ...(list.snoozed ? { snoozed: withoutThread(list.snoozed, threadId) } : {}), ...(list.pins ? { pins: withoutThread(list.pins, threadId) } : {}) };
  }
  // Archived by this line: a time the row does not have yet. A later line of a thread that came back after an archive
  // (an agent wrote after it) carries that older time, as the row does: nothing moves.
  if (row && record.resolved_at !== null && record.resolved_at !== row.resolved_at) {
    const sections: InboxListSection[] = list.sections.map((section) => (listed(section.threads) ? { ...section, threads: withoutThread(section.threads, threadId) } : section));
    return { ...list, cursor: event.seq, sections, ...(list.snoozed ? { snoozed: withoutThread(list.snoozed, threadId) } : {}) };
  }
  const name = record.thread_name ?? null;
  const rename = (rows: readonly InboxListRow[]) => rows.map((row) => (row.thread_id === threadId && row.thread_name !== name ? { ...row, thread_name: name } : row));
  const sections = list.sections.map((section) => {
    const threads = rename(section.threads);
    return threads.some((row, i) => row !== section.threads[i]) ? { ...section, threads } : section;
  });
  const snoozed = list.snoozed ? rename(list.snoozed) : undefined;
  const pins = list.pins ? rename(list.pins) : undefined;
  const moved = (after: readonly InboxListRow[] | undefined, before: readonly InboxListRow[] | undefined) => !!after && after.some((row, i) => row !== before![i]);
  const changed = sections.some((section, i) => section !== list.sections[i]) || moved(snoozed, list.snoozed) || moved(pins, list.pins);
  return changed ? { ...list, cursor: event.seq, sections, ...(snoozed ? { snoozed } : {}), ...(pins ? { pins } : {}) } : null;
}
