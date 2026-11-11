import { useSyncExternalStore } from 'react';
import type { InboxListRow } from '@plannotator/core/inbox-types';
import { storage } from '@plannotator/ui/utils/storage';
import { pinnedState, type PinnedState } from './pins';

export const STARRED_ABOVE_COOKIE = 'plannotator-inbox-starred-above';

export const STARRED_ABOVE_LABEL = 'Keep starred above the list';

export function readStarredAbove(): boolean {
  try {
    return storage.getItem(STARRED_ABOVE_COOKIE) === '1';
  } catch {
    return false;
  }
}

const listeners = new Set<() => void>();
let current: boolean | null = null;
const read = (): boolean => (current ??= readStarredAbove());

export function writeStarredAbove(on: boolean): void {
  try {
    if (on) storage.setItem(STARRED_ABOVE_COOKIE, '1');
    else storage.removeItem(STARRED_ABOVE_COOKIE);
  } catch {
  }
  if (current === on) return;
  current = on;
  for (const listener of [...listeners]) listener();
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};
const off = (): boolean => false;
const ignore = () => () => {};
const noChange = () => {};

export function useStarredAbove(remember = true): [boolean, (on: boolean) => void] {
  const on = useSyncExternalStore(remember ? subscribe : ignore, remember ? read : off, off);
  return [on, remember ? writeStarredAbove : noChange];
}

export function resetStarredAboveForTests(): void {
  current = null;
  for (const listener of [...listeners]) listener();
}

export function pillWaits(state: PinnedState): boolean {
  return state.kind === 'stop' || state.kind === 'hold' || state.kind === 'wait';
}

export interface StarredPill {
  row: InboxListRow;
  label: string;
  project: string;
  twin: boolean;
  state: PinnedState;
}

export function starredPills(rows: readonly InboxListRow[], labelOf: (row: InboxListRow) => string, projectNames?: ReadonlyMap<string, string>): StarredPill[] {
  const labels = rows.map(labelOf);
  const seen = new Map<string, number>();
  for (const label of labels) seen.set(label, (seen.get(label) ?? 0) + 1);
  return rows.map((row, index) => ({
    row,
    label: labels[index]!,
    project: projectNames?.get(row.project.id) ?? row.project.name,
    twin: (seen.get(labels[index]!) ?? 0) > 1,
    state: pinnedState(row),
  }));
}

export function pillStateWords(state: PinnedState): string {
  return state.words || (state.kind === 'wait' ? '1 question' : '');
}

export function pillName(pill: StarredPill): string {
  return [pill.label, pill.project, pillStateWords(pill.state), 'starred'].filter((part) => part.trim() !== '').join(', ');
}

export function moreName(hidden: readonly StarredPill[]): string {
  const waiting = hidden.filter((pill) => pillWaits(pill.state)).length;
  return `${hidden.length} more starred${waiting > 0 ? `, ${waiting} waiting on you` : ''}`;
}

export function fitPills(widths: readonly number[], more: number, width: number, gap: number, lines = 2): number {
  const fits = (count: number, withMore: boolean): boolean => {
    let line = 1;
    let x = 0;
    const place = (w: number) => {
      const at = x === 0 ? 0 : x + gap;
      if (at > 0 && at + w > width) {
        line += 1;
        x = w;
      } else x = at + w;
    };
    for (let i = 0; i < count; i += 1) place(widths[i]!);
    if (withMore) place(more);
    return line <= lines;
  };
  if (fits(widths.length, false)) return widths.length;
  for (let count = widths.length - 1; count > 1; count -= 1) if (fits(count, true)) return count;
  return Math.min(1, widths.length);
}
