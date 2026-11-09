/**
 * The tab icon dialog on the page ("Which favicon do you prefer?"; the owner, 2026-11-09: "Ship it as shown"). An
 * update-day dialog of the line (`tab_icon`, packages/shared/inbox/reveals.ts): the Inbox makes it due at the release
 * start for someone who used an earlier Inbox and never chose a favicon, and names it in `reveal.next`. The page arms it
 * from there (`useLineReveal`) at the line's calm moment: back on the list from a thread, or the page idle (idleClock.ts),
 * 60 s into the page, the list loaded, nothing typed or open, no question waiting in the open thread, no toast. A pick in
 * Settings on this page before then drops it (`holds`); one made elsewhere makes the Inbox refuse the claim.
 *
 * Every way out is final (the claim stamped it): the primary button saves the pick as Settings does (`chooseFavicon`);
 * Escape and a click outside put back the icon the tab loaded with and save nothing. No Not now, and no keyboard
 * shortcut.
 */
import type { InboxListRow } from '@plannotator/core/inbox-types';
import { useRef } from 'react';
import { faviconPickedHere } from './faviconChoice';
import { REVEAL_TIMES, useLineReveal } from './reveal';

export interface TabIconChoiceInput {
  /** The Inbox has it next for this page (settings `reveal.next === 'tab_icon'`), read once per load. */
  due: boolean;
  /** The tour, an update or another one-time dialog was on screen (or due) on this load. */
  blocked: boolean;
  /** The list has loaded and is not the first-run screen. */
  listLoaded: boolean;
  firstRun: boolean;
  thread: string | null;
  rows: readonly InboxListRow[];
  /** The Inbox page with nothing over it, on the list itself, or over a thread while the page is idle. */
  clear: boolean;
  place: string;
  heldBack: () => boolean;
  toast: boolean;
  /** The page is idle (idleClock.ts). */
  idle: boolean;
}

/** Its need at a settled moment: the list loaded, not the first-run screen, the page 60 s old. */
export function tabIconChoiceMayClaim(gate: Pick<TabIconChoiceInput, 'listLoaded' | 'firstRun'>, pageAge: number): boolean {
  return gate.listLoaded && !gate.firstRun && pageAge >= REVEAL_TIMES.pageAgeMs;
}

export function useTabIconChoice(input: TabIconChoiceInput) {
  const latest = useRef(input);
  latest.current = input;
  return useLineReveal({
    id: 'tab_icon',
    due: input.due,
    blocked: input.blocked,
    thread: input.thread,
    rows: input.rows,
    clear: input.clear,
    place: input.place,
    heldBack: input.heldBack,
    toast: input.toast,
    // Back on the list from a thread (not on to another one).
    leaveCounts: (_visit, _now, _row, next) => next === null,
    idle: input.idle,
    mayClaim: (pageAge) => tabIconChoiceMayClaim(latest.current, pageAge),
    // A favicon picked in Settings on this page meanwhile: nothing left to ask.
    holds: () => !faviconPickedHere(),
  });
}
