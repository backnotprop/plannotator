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
 * The order holds as the list does (held.ts, listView.ts): each row is placed by the time it had when the list was
 * last sorted whole (`ListSort`: Show, a thread closing, a refresh, another folder), so a row the person just acted
 * in moves to the top when the list settles, never under the pointer. Each group keeps its place, as with every
 * other filter; the Snoozed band keeps its own order. This file holds no routes or server calls.
 */
import { useMemo, useState } from 'react';
import type { InboxListRow, InboxListSection } from '@plannotator/core/inbox-types';
import { INBOX_SNOOZED_BAND } from '@plannotator/core/inbox-snooze';
import type { ListSort } from './listView';

/** How far back "recent" reaches. */
export const RECENT_ACTIVITY_DAYS = 30;
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

/** Each group's rows newest first by `key` (ties keep the group's order); the Snoozed band as it is. */
export function sortByActed(sections: readonly InboxListSection[], key: ActedKey): InboxListSection[] {
  const time = (row: InboxListRow) => Date.parse(key(row)) || 0;
  return sections.map((section) =>
    section.id === INBOX_SNOOZED_BAND.id || section.threads.length < 2 ? section : { ...section, threads: [...section.threads].sort((a, b) => time(b) - time(a)) },
  );
}

/**
 * The rows' places while Recent activity is on (null while off): a row takes the time it has when first drawn after
 * each whole sort, and keeps it until the next (`sort.epoch`); `sort.keep`'s row keeps the one it had, as List's does.
 */
export function useActedKeys(on: boolean, sort: ListSort): ActedKey | null {
  const [last] = useState(() => ({ keys: null as Map<string, string> | null }));
  return useMemo(() => {
    const placed = on ? actedPlaces(last.keys, sort.keep) : null;
    last.keys = placed?.keys ?? null;
    return placed?.key ?? null;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `last` is this hook's own holder.
  }, [on, sort.epoch, sort.keep]);
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

/** Tests only: forget the films this window saw played. */
export function resetActedHereForTests(): void {
  actedHere.clear();
}
