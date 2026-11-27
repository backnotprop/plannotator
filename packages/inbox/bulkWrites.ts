/**
 * The picks' bar (rowPicks.ts): one action on several threads, with one toast and one Undo. Each thread goes through
 * its own route, so a linked machine's thread goes to that machine as its single action does (api.ts `threadUrl`); a
 * write held for a machine that is away counts as made, and the toast says it applies when that machine is back. The
 * rows are drawn as the single actions draw them (App.tsx `archive`, `markRead`, snoozeWrites.ts, priorityWrites.ts):
 * archived and read rows stay where they are until the list settles; snoozed rows and rows in or out of Priority
 * move now.
 */
import type { Dispatch, SetStateAction } from 'react';
import type { InboxListRow, InboxListSection, InboxPriorityBefore } from '@plannotator/core/inbox-types';
import { plural } from '@plannotator/core/inbox-format';
import { inboxSnoozeRunning, inboxSnoozeWhen } from '@plannotator/core/inbox-snooze';
import { InboxHeldError, inboxApi, type ListModel } from './api';
import { drawnSection, listGroups, markHeldRowArchived, putRowBack, replaceHeldRow, settleThread } from './held';
import { archivedRowPatch, patchShownRow, readRowPatch, shownRowOf } from './rowActions';
import { setAsideCount, type SetAsideCount } from './markRead';
import { currentArchiveAllRows, currentMarkAllRows, currentReaskAllRows } from './markAllRead';
import { postReaskAll } from './data/actions/reaskAll';
import { reaskAllQuiet, reaskAllToast, tallyReaskAll } from './reaskAll';
import { newUuid } from '@plannotator/ui/utils/uuid';
import { batchToastWhy } from './projectMenu';
import type { RowWrites, RowDrawing } from './data/actions/rows';
import { errorToast } from './toastError';
import type { InboxToastModel } from './components/Toast';
import type { BulkAction } from './rowPicks';
import type { CombinesTracker } from './components/useCombines';
import { hideThreadsWithUndo } from './pulls/hiddenPulls';

/** How many threads' writes are on their way at once. */
const AT_ONCE = 6;

export interface BulkHost {
  rowOf: (threadId: string) => InboxListRow | undefined;
  rowWrites: RowWrites;
  setShown: Dispatch<SetStateAction<InboxListSection[] | null>>;
  shownRef: { readonly current: InboxListSection[] | null };
  latestRef: { readonly current: ListModel | null };
  routeRef: { readonly current: { thread?: string | null } };
  listCovered: () => boolean;
  armSlide: () => void;
  afterWrite: (written?: readonly string[]) => Promise<unknown>;
  showToast: (toast: Omit<InboxToastModel, 'id'>) => void;
  dismissToast: () => void;
  say: (text: string) => void;
  warnSetAside: (count: SetAsideCount, bulk: boolean) => Promise<boolean>;
  restoreSnooze: (threadId: string, snooze: InboxListRow['snoozed']) => Promise<void>;
  restorePriority: (threadId: string, priority: InboxListRow['priority']) => Promise<void>;
  /** Mark unread on the open thread closes it (App.tsx `markUnread`). */
  closeThread: () => void;
  /** A Combine's new thread, from its toast (useCombines.ts). */
  openThread: (threadId: string) => void;
}

/** One thread's write: made, held for its machine (named), or refused (why). */
type Outcome<T> = { row: InboxListRow; ok: true; value: T; held: string | null } | { row: InboxListRow; ok: false; cause: unknown };

/** Each row's write, AT_ONCE at a time, in the rows' order. */
export async function eachRow<T>(rows: readonly InboxListRow[], write: (row: InboxListRow) => Promise<T>): Promise<Outcome<T>[]> {
  const out: Outcome<T>[] = new Array(rows.length);
  let next = 0;
  const lane = async () => {
    while (next < rows.length) {
      const at = next++;
      const row = rows[at]!;
      try {
        out[at] = { row, ok: true, value: await write(row), held: null };
      } catch (cause) {
        out[at] = cause instanceof InboxHeldError ? { row, ok: true, value: undefined as T, held: cause.machine?.name ?? 'the other machine' } : { row, ok: false, cause };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(AT_ONCE, rows.length) }, lane));
  return out;
}

const WORDS: Record<BulkAction, (n: string) => string> = {
  archive: (n) => `Archived ${n}`,
  snooze: (n) => `Snoozed ${n}`,
  read: (n) => `Marked ${n} read`,
  reask: (n) => `Asked ${n} again`,
  unread: (n) => `Marked ${n} unread`,
  star: (n) => `Starred ${n}`,
  unstar: (n) => `Unstarred ${n}`,
  'priority-add': (n) => `Added ${n} to Priority`,
  'priority-remove': (n) => `Removed ${n} from Priority`,
  'hide-pulls': (n) => `Hid the pull requests of ${n}`,
};

/**
 * The toast for a bulk action: "Archived 3 threads", "Archived 2 of 3 threads" when some were refused (the first
 * refusal's words after it), and how many wait for a machine that is away. Null when nothing was made.
 */
export function bulkToast(action: BulkAction, outcomes: readonly Outcome<unknown>[], detail?: string): Pick<InboxToastModel, 'icon' | 'lead' | 'phoneLead' | 'detail' | 'wrap'> | null {
  const made = outcomes.filter((o) => o.ok);
  if (made.length === 0) return null;
  const refused = outcomes.filter((o): o is Extract<Outcome<unknown>, { ok: false }> => !o.ok);
  const held = made.filter((o) => o.ok && o.held);
  const total = outcomes.length;
  const count = refused.length > 0 ? `${made.length} of ${plural(total, 'thread')}` : plural(made.length, 'thread');
  const parts: string[] = [];
  if (detail) parts.push(detail);
  if (held.length > 0) {
    const names = [...new Set(held.map((o) => (o.ok ? o.held : null)))];
    parts.push(names.length === 1 ? `${held.length} when ${names[0]} is back` : `${held.length} when their machines are back`);
  }
  if (refused.length > 0) {
    const why = refused[0]!.cause instanceof Error && refused[0]!.cause.message ? refused[0]!.cause.message : 'It didn’t go.';
    parts.push(`${refused.length} did not change: ${why}`);
  }
  return {
    icon: refused.length > 0 ? 'warn' : action === 'archive' ? 'archive' : action === 'snooze' ? 'clock' : action === 'unread' ? 'unread' : 'check',
    lead: WORDS[action](count),
    phoneLead: WORDS[action](String(made.length)),
    ...(parts.length > 0 ? { detail: parts.join(' · ') } : {}),
    ...(refused.length > 0 ? { wrap: true } : {}),
  };
}

/**
 * Mark all as read's and Archive all's toast (the list's ⋮ and a band's menu, markAllRead.ts): the picks' toast with
 * the project menu's words after the count (projectMenu.ts `batchToastWhy`), read from the rows that changed, never one
 * refused: the warning icon when an agent was stopped or held up, a phone's words for it, and the agent's whole name
 * for the live region.
 */
export function batchAllToast(action: 'read' | 'archive', outcomes: readonly Outcome<unknown>[]): Pick<InboxToastModel, 'icon' | 'lead' | 'phoneLead' | 'detail' | 'phoneDetail' | 'speech' | 'wrap'> | null {
  const { why, warn, said, phoneDetail } = batchToastWhy(outcomes.flatMap((o) => (o.ok ? [o.row] : [])));
  const copy = bulkToast(action, outcomes, why || undefined);
  if (!copy) return null;
  const alone = copy.detail === why;
  return {
    ...copy,
    icon: warn ? 'warn' : copy.icon,
    ...(phoneDetail && alone ? { phoneDetail } : {}),
    ...(why ? { speech: `${copy.lead}. ${said && alone ? said : copy.detail}.` } : {}),
  };
}

/** Add tag on the picks: "Tagged 3 threads · Billing", "Removed 3 threads · from Billing". */
export function tagsToast(outcomes: readonly Outcome<unknown>[], tag: string, on: boolean): Pick<InboxToastModel, 'icon' | 'lead' | 'phoneLead' | 'detail' | 'wrap'> | null {
  const copy = bulkToast('archive', outcomes, on ? tag : `from ${tag}`);
  if (!copy) return null;
  const n = copy.lead.replace(/^Archived /, '');
  return { ...copy, icon: copy.icon === 'warn' ? 'warn' : 'check', lead: `${on ? 'Tagged' : 'Removed'} ${n}`, phoneLead: on ? 'Tagged' : 'Removed' };
}

export function bulkWrites(host: BulkHost) {
  const { rowOf, rowWrites, setShown, shownRef, latestRef, routeRef, listCovered, armSlide, afterWrite, showToast, dismissToast, say } = host;
  const ids = (outcomes: readonly Outcome<unknown>[]) => outcomes.filter((o) => o.ok).map((o) => o.row.thread_id);
  /** Every row refused: the window's error toast, as a single action's. */
  const allRefused = (outcomes: readonly Outcome<unknown>[]) => {
    const first = outcomes.find((o) => !o.ok);
    if (first && !first.ok) showToast(errorToast(first.cause, 'The threads did not change.'));
  };
  /** Undo: each made write taken back, then "Moved back." */
  const undoWith = (outcomes: readonly Outcome<unknown>[], back: (o: Extract<Outcome<unknown>, { ok: true }>) => Promise<unknown>, after?: (written: string[]) => void) => () => {
    dismissToast();
    void (async () => {
      const made = outcomes.filter((o): o is Extract<Outcome<unknown>, { ok: true }> => o.ok);
      const undone = await eachRow(
        made.map((o) => o.row),
        (row) => back(made.find((o) => o.row.thread_id === row.thread_id)!),
      );
      await afterWrite(ids(undone));
      after?.(ids(undone));
      const refused = undone.find((o) => !o.ok);
      if (refused && !refused.ok) showToast(errorToast(refused.cause, 'Some threads did not move back.'));
      else say('Moved back.');
    })();
  };
  const finish = (action: BulkAction, outcomes: readonly Outcome<unknown>[], onUndo: () => void, detail?: string, all = false) => {
    const copy = all && (action === 'read' || action === 'archive') ? batchAllToast(action, outcomes) : bulkToast(action, outcomes, detail);
    if (!copy) return allRefused(outcomes);
    showToast({ ...copy, onUndo });
  };
  /** Rows a write moves now (a snooze, Priority): each settles into its group, and Undo puts each back. */
  const moveRows = (threadIds: readonly string[]): InboxListSection[] | null => {
    const drawn = shownRef.current;
    if ((routeRef.current.thread && listCovered()) || !drawn || !latestRef.current || threadIds.length === 0) return null;
    const groups = listGroups(latestRef.current);
    armSlide();
    setShown((current) => (current ? threadIds.reduce((sections, id) => settleThread(sections, groups, id), current) : current));
    return drawn;
  };
  const putBack = (drawnBefore: InboxListSection[] | null) => (threadIds: readonly string[]) => {
    if (!drawnBefore || (routeRef.current.thread && listCovered())) return;
    armSlide();
    setShown((current) =>
      current
        ? threadIds.reduce((sections, id) => {
            const now = rowOf(id);
            return now ? putRowBack(replaceHeldRow(sections, now), drawnBefore, id) : sections;
          }, current)
        : current,
    );
  };

  /**
   * `all`: Archive all (a band's menu, `archiveAll`), with its toast (`batchAllToast`). A thread that came back from the
   * archive is read instead, which archives it again (as the project menu's Archive all does; the picks never take one).
   */
  const archive = async (rows: readonly InboxListRow[], all = false) => {
    const at = new Date().toISOString();
    const drawings = new Map<string, { drawing: RowDrawing; drawn: InboxListRow | null }>();
    for (const row of rows) drawings.set(row.thread_id, { drawing: rowWrites.draw(row.thread_id, { patch: archivedRowPatch(row, at) }), drawn: shownRowOf(shownRef.current, row.thread_id) });
    setShown((current) => (current ? rows.reduce((sections, row) => markHeldRowArchived(sections, row.thread_id, at), current) : current));
    const cameBack = (row: InboxListRow) => !!row.resolved_at;
    const outcomes = await eachRow(rows, (row) => (cameBack(row) ? inboxApi.markRead(row.thread_id, true) : inboxApi.resolve(row.thread_id, true)));
    for (const o of outcomes) {
      if (o.ok) continue;
      const { drawing, drawn } = drawings.get(o.row.thread_id)!;
      drawing.failed();
      if (drawn) setShown((current) => (current ? replaceHeldRow(current, drawn) : current));
    }
    void afterWrite(ids(outcomes)).finally(() => drawings.forEach(({ drawing }) => drawing.done()));
    // Archive ends a snooze and the person's Priority: Undo unarchives first, since an archived thread takes neither.
    // For a machine that is away each is held, in that order, so all three go when it is back.
    finish(
      'archive',
      outcomes,
      undoWith(outcomes, async ({ row }) => {
        if (cameBack(row)) return inboxApi.markRead(row.thread_id, false);
        let held: InboxHeldError | null = null;
        for (const write of [() => inboxApi.resolve(row.thread_id, false), () => host.restoreSnooze(row.thread_id, row.snoozed), () => host.restorePriority(row.thread_id, row.priority)]) {
          try {
            await write();
          } catch (cause) {
            if (!(cause instanceof InboxHeldError)) throw cause;
            held ??= cause;
          }
        }
        if (held) throw held;
      }),
      undefined,
      all,
    );
  };

  const snooze = async (rows: readonly InboxListRow[], until: string) => {
    const outcomes = await eachRow(rows, (row) => inboxApi.snooze(row.thread_id, until));
    await afterWrite(ids(outcomes));
    const drawnBefore = moveRows(ids(outcomes).filter((id) => !!rowOf(id)?.snoozed));
    finish(
      'snooze',
      outcomes,
      undoWith(outcomes, ({ row }) => inboxApi.snooze(row.thread_id, row.snoozed && inboxSnoozeRunning(row.snoozed.until) ? row.snoozed.until : null, row.snoozed?.at), putBack(drawnBefore)),
      inboxSnoozeWhen(until),
    );
  };

  /**
   * False when the warning was cancelled: nothing was written (a drop on Quiet keeps the picks then, listDrops.tsx).
   * Each thread is read as it is now (`rowOf`): the list holds still, so a picked row can be older than its thread
   * (news waiting behind "N new"), and the warning counts the questions the write really closes. A picked row is
   * written whatever waits there (the person picked it). `all`: Mark all as read's toast (`batchAllToast`).
   */
  const markRead = async (picked: readonly InboxListRow[], all = false): Promise<boolean> => {
    const rows = picked.map((row) => rowOf(row.thread_id) ?? row);
    // Questions these would close unanswered: the warning asks once for all of them, as Mark all as read does.
    if (!(await host.warnSetAside(setAsideCount(rows), true))) return false;
    const patch = readRowPatch(new Date().toISOString());
    const drawn = rows.map((row) => shownRowOf(shownRef.current, row.thread_id));
    const drawings = rows.map((row) => rowWrites.draw(row.thread_id, { patch }));
    setShown((current) => (current ? rows.reduce((sections, row) => patchShownRow(sections, row.thread_id, patch), current) : current));
    const outcomes = await eachRow(rows, (row) => inboxApi.markRead(row.thread_id, true));
    // A refused write: its row is drawn as it was (as Archive's), not read until the list settles.
    outcomes.forEach((o, i) => {
      if (o.ok) return;
      drawings[i]!.failed();
      const before = drawn[i];
      if (before) setShown((current) => (current ? replaceHeldRow(current, before) : current));
    });
    void afterWrite(ids(outcomes)).finally(() => drawings.forEach((drawing) => drawing.done()));
    // Mark read ended a snooze: its Undo puts that back too. A thread the person had read before (a read stamp, then
    // Mark unread) goes back by Mark unread, as the project menu's Undo does (project-batch.ts `looked`): a full move
    // back would leave it more unread than it was.
    finish(
      'read',
      outcomes,
      undoWith(outcomes, async ({ row }) => {
        if ((row.read_at ?? null) !== null) await inboxApi.markUnread(row.thread_id);
        else await inboxApi.markRead(row.thread_id, false);
        await host.restoreSnooze(row.thread_id, row.snoozed);
      }),
      undefined,
      all,
    );
    return true;
  };

  /**
   * Mark all as read (the list's ⋮, a band's menu; markAllRead.ts): `drawn`, the rows it took off the list as drawn,
   * each written as its thread is now; a thread whose news waits behind "N new · Show" is left out and stays new
   * (`currentMarkAllRows`). False when nothing was written.
   */
  const markAllRead = async (drawn: readonly InboxListRow[]): Promise<boolean> => {
    const rows = currentMarkAllRows(drawn, rowOf, (id) => drawnSection(shownRef.current, id));
    if (rows.length === 0) return (say('Nothing to mark read.'), false);
    return markRead(rows, true);
  };

  /**
   * Archive all (a band's menu; markAllRead.ts): as Mark all as read, each thread as it is now, and a thread whose
   * news waits behind "N new · Show" is left out (`currentArchiveAllRows`), so a question not seen yet is never
   * archived away. No confirm, as the project menu's: the toast warns when an agent was stopped.
   */
  const archiveAll = async (drawn: readonly InboxListRow[]): Promise<boolean> => {
    const rows = currentArchiveAllRows(drawn, rowOf);
    if (rows.length === 0) return (say('Nothing to archive.'), false);
    await archive(rows, true);
    return true;
  };

  /**
   * Re-ask all (a band's menu, the picks' Re-ask; reaskAll.ts): each thread's own Re-ask to every agent there with a
   * question open, as the thread is now (`currentReaskAllRows`; news behind "N new · Show" leaves it out). One press,
   * one key (a retry answers the same notes); an agent whose note still waits is not asked twice. Nothing is drawn
   * here: each thread's row moves to Sent as its note lands. One toast, no Undo.
   */
  const reaskAll = async (drawn: readonly InboxListRow[]): Promise<boolean> => {
    const rows = currentReaskAllRows(drawn, rowOf, (id) => drawnSection(shownRef.current, id));
    if (rows.length === 0) return (say('Nothing to re-ask.'), false);
    const batch = newUuid();
    const outcomes = await eachRow(rows, (row) => postReaskAll(row.thread_id, batch));
    await afterWrite(outcomes.flatMap((o) => (o.ok && o.value.asked.length > 0 ? [o.row.thread_id] : [])));
    const tally = tallyReaskAll(outcomes);
    const copy = reaskAllToast(tally);
    if (!copy) return (say(reaskAllQuiet(tally)), false);
    showToast(copy);
    return true;
  };

  const markUnread = async (rows: readonly InboxListRow[]) => {
    const outcomes = await eachRow(rows, (row) => inboxApi.markUnread(row.thread_id));
    await afterWrite(ids(outcomes));
    // The open thread closes, as its own Mark unread does: left open, its next look would read it again.
    if (routeRef.current.thread && ids(outcomes).includes(routeRef.current.thread)) host.closeThread();
    finish('unread', outcomes, undoWith(outcomes, (o) => {
      const written = o.value as Awaited<ReturnType<typeof inboxApi.markUnread>> | undefined;
      return written?.wrote ? inboxApi.seen(o.row.thread_id, written.through_seq) : Promise.resolve();
    }));
  };

  const star = async (rows: readonly InboxListRow[], on: boolean) => {
    const drawings = rows.map((row) => rowWrites.draw(row.thread_id, { pin: on }));
    const outcomes = await eachRow(rows, (row) => inboxApi.pin(row.thread_id, on));
    outcomes.forEach((o, i) => !o.ok && drawings[i]!.failed());
    await afterWrite(ids(outcomes)).finally(() => drawings.forEach((drawing) => drawing.done()));
    finish(on ? 'star' : 'unstar', outcomes, undoWith(outcomes, ({ row }) => inboxApi.pin(row.thread_id, !on)));
  };

  const priority = async (rows: readonly InboxListRow[], on: boolean) => {
    const outcomes = await eachRow(rows, (row) => inboxApi.priority(row.thread_id, on));
    await afterWrite(ids(outcomes));
    const drawnBefore = moveRows(ids(outcomes));
    finish(
      on ? 'priority-add' : 'priority-remove',
      outcomes,
      undoWith(outcomes, (o) => {
        const before = (o.value as { before?: InboxPriorityBefore } | undefined)?.before;
        return before ? inboxApi.priority(o.row.thread_id, { restore: before }) : inboxApi.priority(o.row.thread_id, !on);
      }, putBack(drawnBefore)),
    );
  };

  /**
   * Hide the picked threads' open PRs (pulls/hiddenPulls.ts): one write, one toast with Undo (which shows exactly those
   * PRs again); the threads leave the list once it reads again.
   */
  const hidePulls = async (rows: readonly InboxListRow[]) => {
    const ids = rows.map((row) => row.thread_id);
    if (await hideThreadsWithUndo(ids, (toast) => showToast(toast))) await afterWrite(ids);
  };

  // The window's toasts, live region and writes for the picks' other actions (Combine's tracker, useCombines.ts).
  return { archive, archiveAll, snooze, markRead, markAllRead, reaskAll, markUnread, star, priority, hidePulls, host };
}

/** With the Combines the window follows (useCombines.ts), which the picks' Combine… starts. */
export type BulkWrites = ReturnType<typeof bulkWrites> & { combines?: CombinesTracker };
