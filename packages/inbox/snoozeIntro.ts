/**
 * When the one-time Snooze announcement may show (approval "inbox-snooze-announce", 2026-11-02). The Inbox decides who
 * (settings `snooze_intro.due`: packages/server/inbox-snooze-intro.ts, and the reveals' queue, `reveal.next`) and spends the
 * claim (POST /api/inbox/snooze-intro: only the first claim ever gets `show: true`, stamped as it is claimed). The page
 * decides when, only at a calm moment (the shared tracker is reveal.ts):
 *
 *  - right after the person LEAVES a thread that still waits on them without answering it (they close it, go back to
 *    the list, or open another), having had it open for `readMs` (5 s) or more, with nothing left typed in it;
 *  - the list holds two or more threads read and left for a day or more, and three rows or more;
 *  - the page has been loaded for `pageAgeMs` (60 s) or more;
 *  - no tour, update or other one-time dialog on this load, and the page has not snoozed anything itself;
 *  - nothing typed or open over the page, no toast up, and the Inbox page settled for `settledMs` (2.5 s): another
 *    thread, project or machine, or a change in the list, starts that wait again.
 *
 * A moment lasts `momentMs`; one that passes without all of that waits for the next leave. A claimed dialog that
 * cannot open yet waits for a free moment, unless the page snoozes something meanwhile (it would announce what the
 * person just did). Every dismiss is final: the claim already stamped it.
 */
import { useRef } from 'react';
import type { InboxListRow } from '@plannotator/core/inbox-types';
import { inboxApi } from './api';
import { snoozeIntroNeed, snoozeIntroWaits } from './snoozeIntroRows';
import { REVEAL_TIMES, useRevealMoment, type RevealStage, type RevealVisit } from './reveal';

/** A list shorter than this has too little to show Snooze on: the dialog waits for a later load. */
export const SNOOZE_INTRO_MIN_ROWS = 3;

/** The page's thresholds, ms: the reveals' (reveal.ts), one object. A test shrinks them (and puts them back). */
export const SNOOZE_INTRO_TIMES = REVEAL_TIMES;

// Another one-time dialog showed on this load (the Board's first visit, the star ask's card): kept in reveal.ts, which
// the reveals' hooks share, and re-exported here for the callers that always read it from here.
export { noteOneTimeDialogShown, oneTimeDialogShownThisLoad } from './reveal';

/**
 * What else this load showed or has due (App's state; a stage holds it back unless it is 'none'). Every field is
 * required, so App cannot leave one out.
 */
export interface SnoozeIntroOthers {
  tour: boolean;
  updating: boolean;
  sound: unknown;
  agentNote: unknown;
  listIntroWant: boolean;
  listIntro: unknown;
  voiceWanted: boolean;
  voiceStage: unknown;
  /** The Board intro (`oneTimeDialogShownThisLoad`). */
  board: boolean;
}

/** The tour, an update or any other one-time dialog on this load holds the Snooze dialog back for the whole load. */
export function snoozeIntroBlockedBy(o: SnoozeIntroOthers): boolean {
  return o.tour || o.updating || o.sound !== 'none' || o.agentNote !== 'none' || o.listIntroWant || o.listIntro !== 'none' || o.voiceWanted || o.voiceStage !== 'none' || o.board;
}

/** One visit to a thread: which, and when it opened. */
export type SnoozeIntroVisit = RevealVisit;

/**
 * Whether leaving this visit is the moment: open long enough to read, and the thread (as the list has it now) still
 * waits on the person, with nothing of theirs unsent in it. A reply sent moves the thread out of the waiting sections,
 * so "still waits" is also "left without answering".
 */
export function snoozeIntroLeaveCounts(visit: SnoozeIntroVisit, now: number, row: InboxListRow | null): boolean {
  return now - visit.at >= SNOOZE_INTRO_TIMES.readMs && snoozeIntroTargetHolds(row);
}

/**
 * The thread just left, as the list has it now: still there, still waiting on the person, nothing unsent. Checked at
 * the leave, and again before the claim and before the opening (a reply draft saves 500 ms after the last key, so the
 * list can learn of it only after the leave).
 */
export function snoozeIntroTargetHolds(row: InboxListRow | null | undefined): boolean {
  return !!row && snoozeIntroWaits(row) && !row.unsent;
}
const targetRow = (rows: readonly InboxListRow[], threadId: string | null) => rows.find((r) => r.thread_id === threadId);

/** What one load knows (`due`: the load's latch, reveal.ts `useLineLatch`) and what holds now. */
export interface SnoozeIntroGate {
  /** The Inbox has it due for this page (settings `snooze_intro.due`), as the load's latch holds it. */
  due: boolean;
  listLoaded: boolean;
  firstRun: boolean;
  /** The tour, an update or another one-time dialog was on screen (or due) on this load. */
  blocked: boolean;
  /** This page snoozed something on this load. */
  snoozedHere: boolean;
  /** The rows of the list (every section; the Snoozed band apart). */
  rows: readonly InboxListRow[];
  /** Ms since the page loaded. */
  pageAge: number;
  /** A toast is up (never cover an Undo). */
  toast: boolean;
}

/** Whether this load may still show it at all: false ends it for the load. */
export function snoozeIntroWanted(gate: Pick<SnoozeIntroGate, 'due' | 'blocked' | 'snoozedHere'>): boolean {
  return gate.due && !gate.blocked && !gate.snoozedHere;
}

/** Whether, at a settled moment, the page may claim it now. */
export function snoozeIntroMayClaim(gate: Omit<SnoozeIntroGate, 'toast'>, now: Date = new Date()): boolean {
  if (!snoozeIntroWanted(gate) || !gate.listLoaded || gate.firstRun) return false;
  if (gate.pageAge < SNOOZE_INTRO_TIMES.pageAgeMs) return false;
  if (gate.rows.length < SNOOZE_INTRO_MIN_ROWS) return false;
  return snoozeIntroNeed(gate.rows, now);
}

export type SnoozeIntroStage = RevealStage;

export interface SnoozeIntroInput extends Omit<SnoozeIntroGate, 'pageAge'> {
  /** The thread open now (the route's), or null. */
  thread: string | null;
  /** The Inbox page with nothing over it (listIntro.ts `listIntroPageClear`). */
  clear: boolean;
  /** What restarts the settling wait: the thread, project and machine on screen. */
  place: string;
  /** Something typed or open over the page (App's `listIntroHeldBack`). */
  heldBack: () => boolean;
}

/**
 * The moment, the claim and the opening (the shared tracker in reveal.ts). `target`: the thread just left, for Try it.
 */
export function useSnoozeIntro(input: SnoozeIntroInput) {
  const latest = useRef(input);
  latest.current = input;
  return useRevealMoment({
    wanted: snoozeIntroWanted(input),
    thread: input.thread,
    rows: input.rows,
    clear: input.clear,
    place: input.place,
    heldBack: input.heldBack,
    toast: input.toast,
    // Any leave counts (to the list or to another thread), as long as the thread still waits on the person.
    leaveCounts: (visit, now, row) => snoozeIntroLeaveCounts(visit, now, row),
    mayClaim: (pageAge) => snoozeIntroMayClaim({ ...latest.current, pageAge }),
    // Never after the page snoozed something itself, or once the thread just left took a draft, was answered or went.
    holds: (threadId) => !latest.current.snoozedHere && snoozeIntroTargetHolds(targetRow(latest.current.rows, threadId)),
    claim: async () => (await inboxApi.claimSnoozeIntro()).show,
  });
}
