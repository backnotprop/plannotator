import { useSyncExternalStore } from 'react';
import type { InboxListGroupId, InboxListRow, InboxListSection } from '@plannotator/core/inbox-types';
import { INBOX_SNOOZED_BAND } from '@plannotator/core/inbox-snooze';
import { storage } from '@plannotator/ui/utils/storage';

export type ListView = 'grouped' | 'list';

export const LIST_VIEW_COOKIE = 'plannotator-inbox-list-view';

export const LIST_VIEW_LABEL = 'View';
export const LIST_VIEW_OPTIONS: ReadonlyArray<{ value: ListView; label: string }> = [
  { value: 'grouped', label: 'Smart groups' },
  { value: 'list', label: 'Simple list' },
];

export function readListView(): ListView {
  try {
    return storage.getItem(LIST_VIEW_COOKIE) === 'list' ? 'list' : 'grouped';
  } catch {
    return 'grouped';
  }
}

const listeners = new Set<() => void>();
let current: ListView | null = null;
const read = (): ListView => (current ??= readListView());

export function writeListView(view: ListView): void {
  try {
    if (view === 'list') storage.setItem(LIST_VIEW_COOKIE, 'list');
    else storage.removeItem(LIST_VIEW_COOKIE);
  } catch {
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

export function useListView(remember = true): [ListView, (view: ListView) => void] {
  const view = useSyncExternalStore(remember ? subscribe : ignore, remember ? read : grouped, grouped);
  return [view, remember ? writeListView : noChange];
}

export function resetListViewForTests(): void {
  current = null;
  for (const listener of [...listeners]) listener();
}

export interface ListSort {
  epoch: number;
  keep: string | null;
}

export interface ListPlaces {
  epoch: number;
  keys: ReadonlyMap<string, { key: string; group: InboxListGroupId }>;
}

export interface FlatRow {
  row: InboxListRow;
  drawn: InboxListGroupId;
}

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
