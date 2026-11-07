/**
 * The list's view (approval "inbox-list-view", 2026-11-05, issue #2714): Grouped, today's list with its section
 * bands, or List, one list newest first with the same rows and badges and no bands. A choice in the list's ⋮ menu;
 * Grouped is the default.
 *
 * Remembered per browser, as the thread panel and the sidebar's closed sections are: a cookie through `storage`,
 * "list" while List is on and removed for Grouped, so an untouched browser carries none. Never on the server.
 *
 * List never hides a thread the grouped view shows: every section's rows are in it, Quiet and Sent included (Quiet is
 * no longer folded). Snoozed rows keep the grouped view's rule (their folded Snoozed band, under the list), and
 * archived threads stay out, as they do there.
 *
 * Held order applies to List as it does to the groups (held.ts): the list on screen moves only when it settles.
 * A row keeps its place in List while it keeps its group, however its time changes in place (the person's Send in
 * the open thread, Mark read's note); only a settle (`ListSort`: Show, a close, a refresh, another folder) sorts the
 * whole list again, newest first. A row that joins a group (it settled there alone, or is new) takes its place by
 * its time.
 *
 * This file holds no routes or server calls, so another host can share the rule.
 */
import { useSyncExternalStore } from 'react';
import type { InboxListGroupId, InboxListRow, InboxListSection } from '@plannotator/core/inbox-types';
import { INBOX_SNOOZED_BAND } from '@plannotator/core/inbox-snooze';
import { storage } from '@plannotator/ui/utils/storage';

export type ListView = 'grouped' | 'list';

export const LIST_VIEW_COOKIE = 'plannotator-inbox-list-view';

/** The ⋮ menu's words: the group's label and its two choices, in their order. */
export const LIST_VIEW_LABEL = 'View';
export const LIST_VIEW_OPTIONS: ReadonlyArray<{ value: ListView; label: string }> = [
  { value: 'grouped', label: 'Smart groups' },
  { value: 'list', label: 'Simple list' },
];

/** The remembered choice; anything but "list" (or no cookie) is Grouped. */
export function readListView(): ListView {
  try {
    return storage.getItem(LIST_VIEW_COOKIE) === 'list' ? 'list' : 'grouped';
  } catch {
    return 'grouped';
  }
}

const listeners = new Set<() => void>();
/** The choice on this page: read from the cookie once, then each pick (a page with no cookies keeps its own). */
let current: ListView | null = null;
const read = (): ListView => (current ??= readListView());

/** Remember the choice for every list on the page; Grouped removes the cookie. */
export function writeListView(view: ListView): void {
  try {
    if (view === 'list') storage.setItem(LIST_VIEW_COOKIE, 'list');
    else storage.removeItem(LIST_VIEW_COOKIE);
  } catch {
    // A page with no cookies: the choice holds until it reloads.
  }
  if (current === view) return;
  current = view;
  for (const listener of [...listeners]) listener();
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};
const grouped = (): ListView => 'grouped';
const ignore = () => () => {};
const noChange = () => {};

/**
 * The view and its setter, read before the first paint (a reload never draws the groups first). `remember` false
 * (the onboarding tour, as its look and its sidebar ignore this browser's choices): Grouped, nothing read or written.
 */
export function useListView(remember = true): [ListView, (view: ListView) => void] {
  const view = useSyncExternalStore(remember ? subscribe : ignore, remember ? read : grouped, grouped);
  return [view, remember ? writeListView : noChange];
}

/** Tests only: a fresh page that has read nothing. */
export function resetListViewForTests(): void {
  current = null;
  for (const listener of [...listeners]) listener();
}

/**
 * When the list on screen was last sorted whole (App.tsx): `epoch` moves on every settle and adopt (Show, a close,
 * a refresh, another folder), never for a row shown in place or one row moved alone. `keep`: a thread whose row keeps
 * its place through that sort (the open thread beside a title refresh, held.ts `adoptKeepingOpen`).
 */
export interface ListSort {
  epoch: number;
  keep: string | null;
}

/** Each row's place in List: the time it is sorted by, and the group it had when it took it. */
export interface ListPlaces {
  epoch: number;
  keys: ReadonlyMap<string, { key: string; group: InboxListGroupId }>;
}

export interface FlatRow {
  row: InboxListRow;
  /** The group the row is drawn in by the held list (held.ts `drawnSection`): what its actions read. */
  drawn: InboxListGroupId;
}

/**
 * List's rows: every group's rows but the Snoozed band's, newest first (ties on the thread id, as the server sorts a
 * section), each placed by the time it had when it took its place (`places`) unless the list was sorted whole since
 * (`sort`) or it changed group. Returns the rows and the places to keep for the next call. Pure.
 */
export function flatRows(sections: readonly InboxListSection[], places: ListPlaces | null, sort: ListSort): { rows: FlatRow[]; places: ListPlaces } {
  const sorted = places === null || places.epoch !== sort.epoch;
  const keys = new Map<string, { key: string; group: InboxListGroupId }>();
  const rows: Array<FlatRow & { key: string }> = [];
  for (const section of sections) {
    if (section.id === INBOX_SNOOZED_BAND.id) continue;
    for (const row of section.threads) {
      const old = places?.keys.get(row.thread_id);
      const holds = old !== undefined && old.group === section.id && (!sorted || row.thread_id === sort.keep);
      const key = holds ? old.key : row.last_at;
      keys.set(row.thread_id, { key, group: section.id });
      rows.push({ row, drawn: section.id, key });
    }
  }
  rows.sort((left, right) => right.key.localeCompare(left.key) || left.row.thread_id.localeCompare(right.row.thread_id));
  return { rows: rows.map(({ row, drawn }) => ({ row, drawn })), places: { epoch: sort.epoch, keys } };
}
