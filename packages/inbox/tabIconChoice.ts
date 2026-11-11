import type { InboxListRow } from '@plannotator/core/inbox-types';
import { useRef } from 'react';
import { faviconPickedHere } from './faviconChoice';
import { soonMayClaim, useLineReveal } from './reveal';

export interface TabIconChoiceInput {
  due: boolean;
  blocked: boolean;
  listLoaded: boolean;
  firstRun: boolean;
  thread: string | null;
  rows: readonly InboxListRow[];
  clear: boolean;
  place: string;
  heldBack: () => boolean;
  toast: boolean;
}

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
    leaveCounts: () => false,
    atOnce: true,
    mayClaim: (pageAge) => tabIconChoiceMayClaim(latest.current, pageAge),
    holds: () => !faviconPickedHere(),
  });
}
