/**
 * Recent activity as a view of the list, not a filter (the owner, 2026-11-26: "it's just a new sort view… just show me
 * what the recent threads are in a sorted order, but an easy way to exit out of it, too… I wouldn't want it to be a
 * permanent filter"; design A of the mocks: a slim bar above the list with Done, RecentViewBar.tsx).
 *
 * - Turned on from the filter menu's "Recent activity" row (ListFilter.tsx: no count, no tick; the menu closes).
 * - While on, the list is the threads the person acted in during the last 30 days, newest first by that act
 *   (listFilterRecent.ts: the rule, the order and how it holds), within whatever the filter's real picks keep. The
 *   folded Snoozed band is not the view's: its rows and count stay the filter's.
 * - Not a filter: not in the filter's badge, its tooltip, its menu counts or the cookie (listFilter.ts has no
 *   `recent`; an older cookie's `recent: true` is read as nothing).
 * - Kept nowhere: this page's memory only. It lasts until Done, Escape (one more rung of the window's Escape ladder,
 *   after an open thread closes: app/useListView.ts `leaveRecentViewOnEscape`), a reload, or leaving the list it was
 *   turned on in (another project, agent, tag or machine in the sidebar, or another page). Opening and closing threads
 *   keeps it.
 *
 * This file holds no routes or server calls.
 */
import { useEffect, useSyncExternalStore } from 'react';
import type { InboxListSection } from '@plannotator/core/inbox-types';
import { rowRecentlyActed } from './listFilterRecent';

/** The list the view was turned on in (its place: the sidebar's project, machine, agent and tag), or null: off. */
let shownIn: string | null = null;
/** How many times the view has been turned on on this page: the bar says its words once per turn, not per redraw. */
let turns = 0;
const listeners = new Set<() => void>();
const emit = () => {
  for (const listener of [...listeners]) listener();
};
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};
const read = () => shownIn;
const none = () => null;

/** Turn the view on in the list at `place`. */
export function showRecentView(place: string): void {
  if (shownIn === place) return;
  shownIn = place;
  turns += 1;
  emit();
}

/** This turn of the view (RecentViewBar.tsx: announced once per turn). */
export function recentViewTurn(): number {
  return turns;
}

/** Done, Escape, or the list left: the view goes. */
export function leaveRecentView(): void {
  if (shownIn === null) return;
  shownIn = null;
  emit();
}

/** The view is on somewhere (Escape's rung reads it). */
export function recentViewShown(): boolean {
  return shownIn !== null;
}

/** The view is on in the list at `place` (null: no list on screen). */
export function useRecentView(place: string | null): boolean {
  const at = useSyncExternalStore(subscribe, read, none);
  return place !== null && at === place;
}

/** The list left (another place in the sidebar, another page): the view goes, so coming back finds the list as it was. */
export function useRecentViewLeaves(place: string | null): void {
  const at = useSyncExternalStore(subscribe, read, none);
  useEffect(() => {
    if (at !== null && at !== place) leaveRecentView();
  }, [at, place]);
}

/**
 * The list with the view on: of `kept` (what the filter's picks keep of `listed`), only the threads acted in lately,
 * then `held` (listFilterRecent.ts `heldRecentRows`: which rows the list holds until it settles). The Snoozed band keeps
 * the filter's rows, so its count is never the view's.
 */
export function recentViewSections(
  listed: readonly InboxListSection[],
  kept: InboxListSection[],
  held: (listed: readonly InboxListSection[], kept: InboxListSection[], now: number) => InboxListSection[],
  now: number,
): InboxListSection[] {
  const recent = kept.map((section) => (section.id === 'snoozed' ? section : { ...section, threads: section.threads.filter((row) => rowRecentlyActed(row, now)) }));
  return held(listed, recent, now).map((section, i) => (section.id === 'snoozed' ? kept[i]! : section));
}

/** Tests only: a fresh page. */
export function resetRecentViewForTests(): void {
  shownIn = null;
  emit();
}
