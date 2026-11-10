/**
 * The tab icon dialog on the page ("Which favicon do you prefer?"; the owner, 2026-11-09: "Ship it as shown"). An
 * update-day dialog of the line (`tab_icon`, packages/shared/inbox/reveals.ts): the Inbox makes it due at the release
 * start for someone who used an earlier Inbox and never chose a favicon, and names it in `reveal.next`. The page arms it
 * from there (`useLineReveal`) and opens it soon after the page does (the owner, 2026-11-10: "Fifteen seconds after the
 * inbox opens"; reveal.ts `soonMayClaim`, `atOnce`): the page 15 s old and visible, the list loaded, with no thread to
 * read and leave and no stillness to wait for. It still never opens over something typed or open, a question waiting in
 * the open thread, or a toast: it waits for that to end. A pick in Settings on this page before then drops it
 * (`holds`); one made elsewhere makes the Inbox refuse the claim.
 *
 * Every way out is final (the claim stamped it): the primary button saves the pick as Settings does (`chooseFavicon`);
 * Escape and a click outside put back the icon the tab loaded with and save nothing. No Not now, and no keyboard
 * shortcut.
 */
import type { InboxListRow } from '@plannotator/core/inbox-types';
import { useRef } from 'react';
import { faviconPickedHere } from './faviconChoice';
import { soonMayClaim, useLineReveal } from './reveal';

export interface TabIconChoiceInput {
  /** The Inbox has it next for this page (settings `reveal.next === 'tab_icon'`), as the load's latch holds it (reveal.ts `useLineLatch`). */
  due: boolean;
  /** The tour, an update or another one-time dialog was on screen (or due) on this load. */
  blocked: boolean;
  /** The list has loaded and is not the first-run screen. */
  listLoaded: boolean;
  firstRun: boolean;
  thread: string | null;
  rows: readonly InboxListRow[];
  /** The Inbox page with nothing over it: the list, with or without a thread open. */
  clear: boolean;
  place: string;
  heldBack: () => boolean;
  toast: boolean;
}

/** Its need at a settled moment: the list loaded, not the first-run screen, the page 15 s old and visible. */
export function tabIconChoiceMayClaim(gate: Pick<TabIconChoiceInput, 'listLoaded' | 'firstRun'>, pageAge: number): boolean {
  return soonMayClaim(gate, pageAge);
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
    // The moment is now (`atOnce`), never a leave.
    leaveCounts: () => false,
    atOnce: true,
    mayClaim: (pageAge) => tabIconChoiceMayClaim(latest.current, pageAge),
    // A favicon picked in Settings on this page meanwhile: nothing left to ask.
    holds: () => !faviconPickedHere(),
  });
}
