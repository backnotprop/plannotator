/**
 * Starred threads as pills above the list (approval "inbox-starred-pills", 2026-11-10; the record is in
 * `.product/approved/inbox-starred-pills/`, not in this repo). A choice in the list's ⋮ menu, View group, "Keep
 * starred above the list", off by default. Off is the sidebar's Starred section, as before. On: one pill per starred
 * thread above the list's first section, and the sidebar's Starred section is not drawn; never both.
 *
 * Remembered per browser, as the list's view and the thread panel are: a cookie through `storage`, "1" while on and
 * removed when off, so an untouched browser carries none. Never on the server.
 *
 * The pills are the pins (pins.ts): the same threads, the same order (`pins.json`), the same states. Move left and
 * Move right are the sidebar's Move up and Move down. This file holds no routes or server calls.
 */
import { useSyncExternalStore } from 'react';
import type { InboxListRow } from '@plannotator/core/inbox-types';
import { storage } from '@plannotator/ui/utils/storage';
import { pinnedLabel, pinnedState, type PinnedState } from './pins';

export const STARRED_ABOVE_COOKIE = 'plannotator-inbox-starred-above';

/** The ⋮ menu item's words. */
export const STARRED_ABOVE_LABEL = 'Keep starred above the list';

/** The remembered choice; anything but "1" (or no cookie) is off. */
export function readStarredAbove(): boolean {
  try {
    return storage.getItem(STARRED_ABOVE_COOKIE) === '1';
  } catch {
    return false;
  }
}

const listeners = new Set<() => void>();
/** The choice on this page: read from the cookie once, then each tick (a page with no cookies keeps its own). */
let current: boolean | null = null;
const read = (): boolean => (current ??= readStarredAbove());

/** Remember the choice for the list and the sidebar on this page; off removes the cookie. */
export function writeStarredAbove(on: boolean): void {
  try {
    if (on) storage.setItem(STARRED_ABOVE_COOKIE, '1');
    else storage.removeItem(STARRED_ABOVE_COOKIE);
  } catch {
    // A page with no cookies: the choice holds until it reloads.
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

/**
 * The choice and its setter, read before the first paint. The list and the sidebar both read it, so one tick moves
 * the starred threads from one to the other in the same render. `remember` false (the onboarding tour): off, nothing
 * read or written.
 */
export function useStarredAbove(remember = true): [boolean, (on: boolean) => void] {
  const on = useSyncExternalStore(remember ? subscribe : ignore, remember ? read : off, off);
  return [on, remember ? writeStarredAbove : noChange];
}

/** Tests only: a fresh page that has read nothing. */
export function resetStarredAboveForTests(): void {
  current = null;
  for (const listener of [...listeners]) listener();
}

/**
 * Whether a pill's thread waits on the person (Stopped, Holds, open questions; news alone does not): what the "+N"
 * dot and the phone's edge dot say, as the sidebar's closed Starred header counts.
 */
export function pillWaits(state: PinnedState): boolean {
  return state.kind === 'stop' || state.kind === 'hold' || state.kind === 'wait';
}

export interface StarredPill {
  row: InboxListRow;
  label: string;
  /** The project as the window names it. */
  project: string;
  /** Another pill has the same label: both show their project beside it. */
  twin: boolean;
  state: PinnedState;
}

/** The pills, in pin order: each thread's label, its project, its state, and whether another pill shares its label. */
export function starredPills(rows: readonly InboxListRow[], projectNames?: ReadonlyMap<string, string>): StarredPill[] {
  const labels = rows.map(pinnedLabel);
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

/** A pill's accessible name: "label, project, state, starred" ("Invoice retries, billing-svc, 1 question, starred"). */
export function pillName(pill: StarredPill): string {
  return `${pill.label}, ${pill.project}, ${pill.state.words}, starred`;
}

/** The "+N" pill's accessible name: "22 more starred", and ", 1 waiting on you" when a hidden one waits. */
export function moreName(hidden: readonly StarredPill[]): string {
  const waiting = hidden.filter((pill) => pillWaits(pill.state)).length;
  return `${hidden.length} more starred${waiting > 0 ? `, ${waiting} waiting on you` : ''}`;
}

/**
 * How many pills show before "+N": as many as fit on `lines` lines of `width` (pills wrap, `gap` between them),
 * the "+N" pill (`more` wide) at the end of the last line when any are left over. Every pill when they all fit.
 * At least one pill shows whenever there is one, however narrow the list. Pure.
 */
export function fitPills(widths: readonly number[], more: number, width: number, gap: number, lines = 2): number {
  /** The line the next pill would start, and the x after the pills placed, with the first `count` pills (and the "+N" pill) placed. */
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
