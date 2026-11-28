import type { InboxListRow, InboxListSection } from '@plannotator/core/inbox-types';
import type { InboxEvent, ListModel } from '../../api';

const withoutThread = (rows: readonly InboxListRow[], threadId: string) => rows.filter((row) => row.thread_id !== threadId);

export function applyListRecord(list: ListModel, event: InboxEvent): ListModel | null {
  if (event.kind !== 'message' || event.seq <= list.cursor) return null;
  const record = event.message;
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
