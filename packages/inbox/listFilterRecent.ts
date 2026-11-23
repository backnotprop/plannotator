/**
 * The list filter's "Recent activity" (approval "inbox-recent-activity-filter"; the menu row is ListFilter.tsx, the
 * pick listFilter.ts's `recent`): only the threads the person did something in during the last
 * `RECENT_ACTIVITY_DAYS` days, newest first by when they last did.
 *
 * When is the row's `acted_at` (the server's rule, shared's inbox/acted.ts: a message, a pick, an action item's
 * mark, a comment, a draft, an open), or a film this window saw the person play since (recentActs.ts), whichever is
 * later. Tidying from the list (a star, Priority, a snooze, archive, a tag, mark read or unread) and anything an
 * agent does never sets it.
 *
 * While on, the list is one list, newest first by that time, whatever the view (Smart groups, Simple list or Agents):
 * the owner asked for "the most recent ones I actually interacted with", so a minute-old act in Quiet never draws
 * under a week-old one in Waiting on you. It is Simple list's own drawing (InboxList.tsx draws List while
 * `ListSort.by` is set; listView.ts `flatRows`), its folded Snoozed band included; the view chosen in the ⋮ menu is
 * left as it is and comes back when the pick goes. The order holds as the list does (held.ts): each row is placed by
 * the time it had when the list was last sorted whole (`ListSort`: Show, a thread closing, a refresh, another folder),
 * so a row the person just acted in moves to the top when the list settles, never under the pointer. Which rows it
 * keeps holds the same way (`heldRecentRows`): a thread that comes into the filter between two whole sorts (an open
 * from search or a notification, an act on the phone) waits for the next one, as a row's new place does, so no row
 * is pushed down under the pointer. This file holds no routes or server calls.
 */
import { useMemo, useState } from 'react';
import { INBOX_RECENT_ACTIVITY_DAYS, type InboxListRow, type InboxListSection } from '@plannotator/core/inbox-types';
import type { ListSort } from './listView';

/** How far back "recent" reaches. */
export const RECENT_ACTIVITY_DAYS = INBOX_RECENT_ACTIVITY_DAYS;
const DAY_MS = 86_400_000;

/** Films the person played in this window, by thread, since the list was read (recentActs.ts writes them). */
const actedHere = new Map<string, string>();

/** The later of two ISO times. */
function later(a: string | null | undefined, b: string | null | undefined): string | null {
  if (!a) return b ?? null;
  if (!b) return a;
  return Date.parse(b) > Date.parse(a) ? b : a;
}

/** The person did something in the thread in this window now, which the next list read carries too. */
export function noteActedHere(threadId: string, at = new Date().toISOString()): void {
  actedHere.set(threadId, later(actedHere.get(threadId), at)!);
}

/** When the person last did something in the row's thread, or null. */
export function rowActedAt(row: Pick<InboxListRow, 'thread_id' | 'acted_at'>): string | null {
  return later(row.acted_at, actedHere.get(row.thread_id));
}

/** The row is kept by Recent activity: the person did something there within the last `RECENT_ACTIVITY_DAYS` days. */
export function rowRecentlyActed(row: Pick<InboxListRow, 'thread_id' | 'acted_at'>, now: number): boolean {
  const at = rowActedAt(row);
  return at !== null && Date.parse(at) >= now - RECENT_ACTIVITY_DAYS * DAY_MS;
}

/** A row's place in the order: the later the time, the higher. */
export type ActedKey = (row: InboxListRow) => string;

/**
 * The rows' places while Recent activity is on (null while off): a row takes the time it has when first drawn after
 * each whole sort, and keeps it until the next (`sort.epoch`, or `backs`: a Back to a covered list); `sort.keep`'s row
 * keeps the one it had, as List's does.
 */
export function useActedKeys(on: boolean, sort: ListSort, backs = 0): ActedKey | null {
  const [last] = useState(() => ({ keys: null as Map<string, string> | null }));
  return useMemo(() => {
    const placed = on ? actedPlaces(last.keys, sort.keep) : null;
    last.keys = placed?.keys ?? null;
    return placed?.key ?? null;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `last` is this hook's own holder.
  }, [on, sort.epoch, sort.keep, backs]);
}

/**
 * Back from a thread to a list it covered (a phone, a stacked window; `covered`, app/focus.ts `listCovered`): there
 * the list settled when the thread opened (App.tsx, `COVERED_LIST_SETTLES`), before the open was an act, and no
 * settle comes after Back. Recent activity sorts whole at it instead, as a close beside the list does after its
 * beat, so the thread just read is at the top when the list shows. Counts those Backs, and names the sort epoch the
 * last came in (its sort keeps no row: `keep` is the open thread's, which is closed now).
 */
export function useCoveredBacks(thread: string | null, covered: () => boolean, epoch: number): { backs: number; epoch: number | null } {
  const [seen, setSeen] = useState({ thread, backs: 0, epoch: null as number | null });
  if (seen.thread !== thread) {
    // Set while drawing (React draws again at once, before anything shows): the list shows already sorted.
    const back = seen.thread !== null && thread === null && covered();
    setSeen({ thread, backs: seen.backs + (back ? 1 : 0), epoch: back ? epoch : seen.epoch });
  }
  return seen;
}

/** One whole sort's places: empty but for `keep`'s row (its place from `before`); each row takes its time when first asked. */
export function actedPlaces(before: ReadonlyMap<string, string> | null, keep: string | null): { keys: Map<string, string>; key: ActedKey } {
  const keys = new Map<string, string>();
  const kept = keep ? before?.get(keep) : undefined;
  if (keep && kept !== undefined) keys.set(keep, kept);
  const key = (row: InboxListRow) => {
    let at = keys.get(row.thread_id);
    if (at === undefined) {
      at = rowActedAt(row) ?? '';
      keys.set(row.thread_id, at);
    }
    return at;
  };
  return { keys, key };
}

/**
 * The filter's rows while the list holds: `kept` (the filter's live answer) less each row whose time as of the last
 * whole sort (`key`) was not recent. Every row of `listed` (the list before the filter) is asked first, so a row that
 * had no recent act at the sort keeps that answer until the next one, however it is drawn meanwhile.
 */
export function heldRecentRows(listed: readonly InboxListSection[], kept: InboxListSection[], key: ActedKey, now: number): InboxListSection[] {
  for (const section of listed) for (const row of section.threads) key(row);
  const reach = now - RECENT_ACTIVITY_DAYS * DAY_MS;
  return kept.map((section) => ({ ...section, threads: section.threads.filter((row) => { const at = key(row); return at !== '' && Date.parse(at) >= reach; }) }));
}

/** What Recent activity gives the list while on (useListView.ts): the sort InboxList reads, and the filter's held rows. */
export interface RecentActivity {
  /** `listSort` with Recent activity's places as `by` while on, which also draws List's one list whatever the view. */
  sort: ListSort;
  /** `heldRecentRows` with this sort's places; null while off. */
  held: ((listed: readonly InboxListSection[], kept: InboxListSection[], now: number) => InboxListSection[]) | null;
}

/** `thread` and `covered`: the open thread, and whether it covers the list (`useCoveredBacks`). */
export function useRecentActivity(on: boolean, listSort: ListSort, thread: string | null = null, covered: () => boolean = () => false): RecentActivity {
  const back = useCoveredBacks(thread, covered, listSort.epoch);
  // A Back's whole sort keeps no row, until the next one.
  const keep = back.epoch === listSort.epoch ? null : listSort.keep;
  const key = useActedKeys(on, keep === listSort.keep ? listSort : { ...listSort, keep }, back.backs);
  return useMemo(
    () => ({ sort: key ? { ...listSort, keep, by: key } : listSort, held: key ? (listed, kept, now) => heldRecentRows(listed, kept, key, now) : null }),
    [key, keep, listSort],
  );
}

/** Tests only: forget the films this window saw played. */
export function resetActedHereForTests(): void {
  actedHere.clear();
}
