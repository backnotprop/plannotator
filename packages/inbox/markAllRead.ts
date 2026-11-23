/**
 * Mark all as read and Archive all on the list (the list's ⋮, and a group band's right-click or long-press menu):
 * which rows each takes. Pure. The project menu's rules (App.tsx `projectAction`, shared/inbox/project-batch.ts):
 * Mark all as read takes every row single Mark read is offered on (markRead.ts `offersRowMarkRead`), Archive all every
 * row not archived; neither ever takes a snoozed row. The ⋮ takes every row the list shows (its filter is already in
 * `sections`); a band takes only its own rows. bulkWrites.ts `markAllRead` and `archiveAll` write them
 * (`currentMarkAllRows`, `currentArchiveAllRows`), with one toast and one Undo.
 */
import { inboxRowArchived, type InboxListGroupId, type InboxListRow, type InboxListSection } from '@plannotator/core/inbox-types';
import { waitsBehindShow } from './held';
import { offersRowMarkRead } from './markRead';
import { isContested, machineOf, selfMachineId } from './inboxUrl';
import type { BulkWrites } from './bulkWrites';
import type { BandMenu } from './components/RowMenu';

/**
 * A band menu's items, in their order: the project menu's words ("Mark all as read", "Archive all"), then Re-ask all
 * on a band of open questions (reaskAll.ts).
 */
export type BandMenuAction = 'read' | 'archive' | 'reask';

/**
 * The groups Re-ask all is offered on (the owner is still choosing the list, 2026-11-21): the one place to change it.
 */
export const REASK_GROUPS: ReadonlySet<InboxListGroupId> = new Set<InboxListGroupId>(['stopped', 'holding', 'waiting']);

/**
 * Whether Re-ask all can write this row's thread from here: this Inbox's own (where its routes go). A linked
 * machine's row is not part of Re-ask all at all (that Inbox's door does not take the route): never offered on,
 * never written, never counted.
 */
export function reaskReaches(row: Pick<InboxListRow, 'thread_id'>): boolean {
  const machine = machineOf(row.thread_id);
  return (!machine || machine === selfMachineId()) && !isContested(row.thread_id);
}

/**
 * A row Re-ask all takes: this Inbox's own, drawn in a group of open questions, with a question open, and not already
 * asked again (its every open question is in a Re-ask note that still waits, `reask_pending`; such a row is in Sent anyway).
 */
export function offersRowReask(row: InboxListRow, drawn: InboxListGroupId | null): boolean {
  return drawn !== null && REASK_GROUPS.has(drawn) && row.questions.open > 0 && row.reask_pending !== true && reaskReaches(row);
}

/** The rows of these sections that `takes`, each once, in the order drawn. */
function each(sections: readonly InboxListSection[], takes: (row: InboxListRow, drawn: InboxListGroupId) => boolean): InboxListRow[] {
  const seen = new Set<string>();
  const out: InboxListRow[] = [];
  for (const section of sections) {
    for (const row of section.threads) {
      if (seen.has(row.thread_id) || row.snoozed || !takes(row, section.id)) continue;
      seen.add(row.thread_id);
      out.push(row);
    }
  }
  return out;
}

/** The list's ⋮ Mark all as read: every row the list shows that takes it. */
export function listMarkAllRows(sections: readonly InboxListSection[]): InboxListRow[] {
  return each(sections, offersRowMarkRead);
}

/** A band's Mark all as read: that band's rows that take Mark read. */
export function bandMarkAllRows(section: InboxListSection): InboxListRow[] {
  return each([section], offersRowMarkRead);
}

/**
 * A band's Archive all: that band's rows not archived. A thread that came back from the archive (an agent wrote in it
 * since) is taken too: Archive all reads it, which archives it again, as the project menu's does.
 */
export function bandArchiveAllRows(section: InboxListSection): InboxListRow[] {
  return each([section], (row) => !inboxRowArchived(row));
}

/** A band's Re-ask all: that band's rows with a question open, on a band of open questions only. */
export function bandReaskAllRows(section: InboxListSection): InboxListRow[] {
  return each([section], offersRowReask);
}

/** The items a band's menu offers: none (no menu, the browser's own) when none has anything to take. */
export function bandMenuActions(section: InboxListSection): BandMenuAction[] {
  const out: BandMenuAction[] = [];
  if (bandMarkAllRows(section).length > 0) out.push('read');
  if (bandArchiveAllRows(section).length > 0) out.push('archive');
  if (bandReaskAllRows(section).length > 0) out.push('reask');
  return out;
}

/**
 * A group band's menu (RowMenu.tsx `bands`): Mark all as read, Archive all and Re-ask all on that band's threads, each
 * written as its thread is now (bulkWrites.ts). `onOpened`: a band's menu really opened (not a press that only took its look).
 */
export function bandMenuOf(sections: readonly InboxListSection[], bulk: Pick<BulkWrites, 'markAllRead' | 'archiveAll' | 'reaskAll'>, onOpened: () => void): BandMenu {
  const bandSection = (id: string) => sections.find((section) => section.id === id);
  return {
    actionsOf: (id) => {
      const section = bandSection(id);
      return section ? bandMenuActions(section) : [];
    },
    labelOf: (id) => bandSection(id)?.label ?? '',
    stateOf: (id) => bandSection(id)?.threads.map((row) => row.thread_id).join(' ') ?? '',
    onAction: (id, action) => {
      const section = bandSection(id);
      if (!section) return;
      if (action === 'reask') return void bulk.reaskAll(bandReaskAllRows(section));
      const rows = action === 'read' ? bandMarkAllRows(section) : bandArchiveAllRows(section);
      if (action === 'archive') void bulk.archiveAll(rows);
      else if (rows.length > 0) void bulk.markAllRead(rows);
    },
    onOpened,
  };
}

/**
 * The rows a batch writes, from the rows it took off the list as drawn: each thread's row as it is now (`rowOf`), since
 * the list holds still and a drawn row can be older (held.ts `refreshHeldRows`). A thread with agent activity the list
 * has not shown yet is left out: that news waits behind "N new · Show", and the batch would close a question the
 * person never saw, so the thread stays as it is. So is a thread gone from the list or snoozed since, or one the batch
 * no longer `takes` as it is now.
 */
function current(drawn: readonly InboxListRow[], rowOf: (threadId: string) => InboxListRow | undefined, takes: (now: InboxListRow) => boolean): InboxListRow[] {
  return drawn.flatMap((row) => {
    const now = rowOf(row.thread_id);
    return now && !now.snoozed && !waitsBehindShow(row, now) && takes(now) ? [now] : [];
  });
}

/** Mark all as read's rows as they are now; one read elsewhere is left out. `drawnIn`: the group the list draws the thread in. */
export function currentMarkAllRows(
  drawn: readonly InboxListRow[],
  rowOf: (threadId: string) => InboxListRow | undefined,
  drawnIn: (threadId: string) => InboxListGroupId | null,
): InboxListRow[] {
  return current(drawn, rowOf, (now) => offersRowMarkRead(now, drawnIn(now.thread_id)));
}

/** Re-ask all's rows as they are now; one answered, asked again or moved out of the question groups since is left out. */
export function currentReaskAllRows(
  drawn: readonly InboxListRow[],
  rowOf: (threadId: string) => InboxListRow | undefined,
  drawnIn: (threadId: string) => InboxListGroupId | null,
): InboxListRow[] {
  return current(drawn, rowOf, (now) => offersRowReask(now, drawnIn(now.thread_id)));
}

/** Archive all's rows as they are now; one archived elsewhere is left out. */
export function currentArchiveAllRows(drawn: readonly InboxListRow[], rowOf: (threadId: string) => InboxListRow | undefined): InboxListRow[] {
  return current(drawn, rowOf, (now) => !inboxRowArchived(now));
}
