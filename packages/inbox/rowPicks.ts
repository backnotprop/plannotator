/**
 * Picking thread rows (approval "inbox-multi-select", 1B + 2A): ⌘ or Ctrl and a click picks a row, Shift and a click
 * picks the rows between it and the last one picked, and the row's menu (or the list's ⋮, or a finger held on a row)
 * starts picking with nothing or that row picked. While picking, a plain click picks too, the list's header is the
 * picks' bar, and Escape or Done leaves. The bar's actions take every picked row at once, with one toast and one Undo.
 * The state is the list's own (InboxList.tsx); what each action takes is decided here. Pure but for the hook.
 */
import { useCallback, useMemo, useRef, useState } from 'react';
import { inboxRowArchived, type InboxListGroupId, type InboxListRow } from '@plannotator/core/inbox-types';
import { canMarkUnread, offersRowMarkRead } from './markRead';
import { offersRowReask, reaskReaches } from './markAllRead';
import { priorityAction } from './priority';

export type PickPress = 'toggle' | 'range';

/** A press on a row while picking, or with ⌘/Ctrl or Shift: the picks after it. `order`: the rows as drawn. */
export function pressPick(picked: ReadonlySet<string>, id: string, how: PickPress, anchor: string | null, order: readonly string[]): Set<string> {
  const next = new Set(picked);
  const a = anchor ? order.indexOf(anchor) : -1;
  const b = order.indexOf(id);
  if (how === 'range' && a >= 0 && b >= 0) {
    for (const key of order.slice(Math.min(a, b), Math.max(a, b) + 1)) next.add(key);
    return next;
  }
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

/** A box over several rows (the bar's, a group's): picks them all, or lets them all go when all are picked. */
export function pickAll(picked: ReadonlySet<string>, ids: readonly string[]): Set<string> {
  const all = ids.length > 0 && ids.every((id) => picked.has(id));
  const next = new Set(picked);
  for (const id of ids) {
    if (all) next.delete(id);
    else next.add(id);
  }
  return next;
}

export type BoxState = 'none' | 'some' | 'all';

export function boxState(ids: readonly string[], picked: ReadonlySet<string>): BoxState {
  const n = ids.filter((id) => picked.has(id)).length;
  return n === 0 ? 'none' : n === ids.length ? 'all' : 'some';
}

/** What the bar and a picked row's menu do to the picked rows. */
export type BulkAction = 'archive' | 'snooze' | 'read' | 'reask' | 'unread' | 'star' | 'unstar' | 'priority-add' | 'priority-remove' | 'hide-pulls';

/** What a row can take: the menus' own rules (rowMenu.ts), and its machine's (machines.ts). */
export interface PickRules {
  /** The group the row is drawn in (a seen update held in New keeps Mark read). */
  drawn: (row: InboxListRow) => InboxListGroupId | null;
  snoozes: (row: InboxListRow) => boolean;
  /** Starred now, or null when its machine takes no star from this one (or the Inbox keeps none). */
  starred: (row: InboxListRow) => boolean | null;
  prioritizes: (row: InboxListRow) => boolean;
}

/** The picked rows an action takes; a row it cannot take is left as it is. */
export function bulkTargets(rows: readonly InboxListRow[], action: BulkAction, rules: PickRules): InboxListRow[] {
  return rows.filter((row) => {
    const archived = inboxRowArchived(row);
    switch (action) {
      case 'archive':
        return row.resolved_at === null;
      case 'snooze':
        return !archived && rules.snoozes(row);
      case 'read':
        return rules.drawn(row) !== 'archived' && offersRowMarkRead(row, rules.drawn(row));
      case 'reask':
        // Re-ask all on the picks (reaskAll.ts): a row with a question open, drawn in a group of open questions.
        return offersRowReask(row, rules.drawn(row));
      case 'unread':
        return rules.drawn(row) !== 'archived' && canMarkUnread(row);
      case 'star':
        return rules.starred(row) === false;
      case 'unstar':
        return rules.starred(row) === true;
      case 'priority-add':
      case 'priority-remove':
        return rules.prioritizes(row) && priorityAction(row) === action;
      case 'hide-pulls':
        // Rows with open PRs not hidden (`hide_pulls`, this Inbox's own rows only): Hide takes those PRs.
        return row.resolved_at === null && (row.hide_pulls?.length ?? 0) > 0;
    }
  });
}

/**
 * Re-ask on the picks: only when every picked thread of this Inbox has a question open for the person (the band's
 * Re-ask all). A linked machine's picked row is not part of it (`reaskReaches`): it neither offers nor blocks it.
 */
export function offersPicksReask(rows: readonly InboxListRow[], rules: PickRules): boolean {
  const own = rows.filter(reaskReaches);
  return own.length > 0 && bulkTargets(own, 'reask', rules).length === own.length;
}

export interface RowPicks {
  /** Picking: the header is the bar, a click picks. */
  on: boolean;
  picked: ReadonlySet<string>;
  /** Start picking, with `id` picked when given. */
  start: (id?: string) => void;
  leave: () => void;
  press: (id: string, how: PickPress, order: readonly string[]) => void;
  /** A box over several rows. */
  all: (ids: readonly string[]) => void;
  /** Let these go (an action took them off the list). */
  drop: (ids: readonly string[]) => void;
}

/** The list's picks. `listed`: is a thread still in the list (a pick that left it drops out). */
export function useRowPicks(listed: (id: string) => boolean): RowPicks {
  const [on, setOn] = useState(false);
  const [raw, setRaw] = useState<ReadonlySet<string>>(() => new Set());
  // Where a Shift press's range starts: the row last pressed.
  const anchor = useRef<string | null>(null);
  const picked = useMemo(() => new Set([...raw].filter(listed)), [raw, listed]);
  const leave = useCallback(() => {
    setOn(false);
    setRaw(new Set());
    anchor.current = null;
  }, []);
  const start = useCallback((id?: string) => {
    setOn(true);
    if (id) {
      anchor.current = id;
      setRaw((was) => new Set(was).add(id));
    }
  }, []);
  const press = useCallback((id: string, how: PickPress, order: readonly string[]) => {
    setOn(true);
    const from = anchor.current;
    anchor.current = id;
    setRaw((was) => pressPick(was, id, how, from, order));
  }, []);
  const all = useCallback((ids: readonly string[]) => setRaw((was) => pickAll(was, ids)), []);
  const drop = useCallback((ids: readonly string[]) => setRaw((was) => new Set([...was].filter((id) => !ids.includes(id)))), []);
  return useMemo(() => ({ on, picked, start, leave, press, all, drop }), [on, picked, start, leave, press, all, drop]);
}
