/**
 * The calm moment for a one-time reveal (approval "inbox-feature-reveal", 2026-11-03; first built for the Snooze
 * announcement, approval "inbox-snooze-announce"). The Inbox decides which reveal this page may arm (settings
 * `reveal.next`, packages/shared/inbox/reveals.ts) and spends the claim; the page decides when:
 *
 *  - right after the person LEAVES a thread they had open for `readMs` (5 s) or more (each reveal says which leaves
 *    count: Snooze's thread must still wait on them; the Board's leave must land on the list);
 *  - the page has been loaded for `pageAgeMs` (60 s) or more, and the list holds enough rows (each reveal's own need);
 *  - no tour, update or other one-time dialog on this load;
 *  - nothing typed or open over the page, no toast up, and the Inbox page settled for `settledMs` (2.5 s): another
 *    thread, project or machine, or a change in the list, starts that wait again.
 *
 * A moment lasts `momentMs`; one that passes without all of that waits for the next leave. A claimed reveal that
 * cannot open yet waits for a free moment (unless the reveal says it no longer holds). Every way out is final: the
 * claim already stamped it.
 */
import { useEffect, useRef, useState } from 'react';
import type { InboxListRow } from '@plannotator/core/inbox-types';
import { inboxApi } from './api';
import { LIST_INTRO_SETTLED_MS } from './listIntro';

/** The page's thresholds, ms, shared by every reveal. A test shrinks them (and puts them back). */
export const REVEAL_TIMES = {
  /** The page has been loaded this long. */
  pageAgeMs: 60_000,
  /** The thread was open this long before the person left it: they read it. */
  readMs: 5_000,
  /** The Inbox page settled this long, without a break. */
  settledMs: LIST_INTRO_SETTLED_MS,
  /** How long after the leave the moment lasts. */
  momentMs: 15_000,
  /** How often a moment that is held back (something typed, open or toasting) looks again. */
  recheckMs: 700,
};

/** One visit to a thread: which, and when it opened. */
export interface RevealVisit {
  threadId: string;
  at: number;
}

export type RevealStage = 'none' | 'claimed' | 'open' | 'shown';

export interface RevealMomentInput {
  /** This load may still show it (armed, nothing blocking). False ends the watch. */
  wanted: boolean;
  /** The thread open now (the route's), or null. */
  thread: string | null;
  /** The rows of the list (every section; the Snoozed band apart). */
  rows: readonly InboxListRow[];
  /** The Inbox page with nothing over it (listIntro.ts `listIntroPageClear`). */
  clear: boolean;
  /** What restarts the settling wait: the thread, project and machine on screen. */
  place: string;
  /** Something typed or open over the page. */
  heldBack: () => boolean;
  /** A toast is up (never cover an Undo). */
  toast: boolean;
  /** Leaving `visit` (its row as the list has it now) for `next` (the thread open now, or null) makes the moment. */
  leaveCounts: (visit: RevealVisit, now: number, row: InboxListRow | null, next: string | null) => boolean;
  /** At a settled moment: the page may claim now (checked once per moment; false drops it). */
  mayClaim: (pageAge: number) => boolean;
  /** The thread just left still makes the reveal true: checked before the claim and before the opening. */
  holds: (threadId: string) => boolean;
  /** Spend the claim: true only for the first claim ever. */
  claim: () => Promise<boolean>;
}

/** A row's state in the list, for "the list settled": ids, sections and what is unseen. */
function listKey(rows: readonly InboxListRow[]): string {
  return rows.map((row) => `${row.thread_id}:${row.section}:${row.unseen}`).join('|');
}

/**
 * The leave tracker, the settling wait, the claim and the opening, for one reveal. `target`: the thread just left.
 */
export function useRevealMoment(input: RevealMomentInput) {
  const [stage, setStage] = useState<RevealStage>('none');
  const [moment, setMoment] = useState<RevealVisit | null>(null);
  const [target, setTarget] = useState<string | null>(null);
  const [settled, setSettled] = useState(false);
  const loadAt = useRef(Date.now());
  const asked = useRef(false);
  const visit = useRef<RevealVisit | null>(null);
  const latest = useRef(input);
  latest.current = input;
  const watching = input.wanted && stage === 'none' && !asked.current;

  // Each change of the open thread: leaving one that counts makes the moment.
  useEffect(() => {
    const now = Date.now();
    const left = visit.current;
    visit.current = input.thread ? { threadId: input.thread, at: now } : null;
    if (!left || left.threadId === input.thread || !watching) return;
    const row = latest.current.rows.find((r) => r.thread_id === left.threadId) ?? null;
    if (latest.current.leaveCounts(left, now, row, input.thread)) setMoment({ threadId: left.threadId, at: now });
    // `watching` is read, not watched: a visit is what changes it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [input.thread]);

  // A moment lasts so long.
  useEffect(() => {
    if (!moment) return;
    const timer = setTimeout(() => setMoment(null), Math.max(0, moment.at + REVEAL_TIMES.momentMs - Date.now()));
    return () => clearTimeout(timer);
  }, [moment]);

  // The settling wait, from the moment, again after each change of place or list.
  const key = listKey(input.rows);
  useEffect(() => {
    setSettled(false);
    if (!moment || !input.clear || !watching) return;
    const timer = setTimeout(() => setSettled(true), REVEAL_TIMES.settledMs);
    return () => clearTimeout(timer);
  }, [moment, input.clear, input.place, key, watching]);

  // Settled at a moment: the gate decides once (a moment that fails it is dropped, and the next leave is the next
  // chance); something typed, open or toasting only makes it wait, while the moment lasts.
  const ready = settled && moment !== null && watching;
  useEffect(() => {
    if (!ready || !moment) return;
    const step = () => {
      const now = latest.current;
      if (asked.current) return true;
      if (now.heldBack() || now.toast) return false;
      if (!now.mayClaim(Date.now() - loadAt.current) || !now.holds(moment.threadId)) {
        setMoment(null);
        return true;
      }
      asked.current = true;
      setTarget(moment.threadId);
      now
        .claim()
        .then((show) => setStage(show ? 'claimed' : 'shown'))
        .catch(() => setStage('shown'));
      return true;
    };
    if (step()) return;
    const timer = setInterval(() => {
      if (step()) clearInterval(timer);
    }, REVEAL_TIMES.recheckMs);
    return () => clearInterval(timer);
  }, [ready, moment]);

  // Claimed: it opens once the page is free; never once the reveal no longer holds (it is spent either way).
  const claimed = stage === 'claimed';
  useEffect(() => {
    if (!claimed) return;
    const step = () => {
      const now = latest.current;
      if (target === null || !now.holds(target)) {
        setStage('shown');
        return true;
      }
      if (now.heldBack() || now.toast || !now.clear) return false;
      setStage('open');
      return true;
    };
    if (step()) return;
    const timer = setInterval(() => {
      if (step()) clearInterval(timer);
    }, REVEAL_TIMES.recheckMs);
    return () => clearInterval(timer);
  }, [claimed]);

  return { stage, target, close: () => setStage('shown') };
}

/** What a load arms, read once from settings: the reveal that is next, and whether that is Snooze's announcement. */
export interface RevealArmed {
  next: 'snooze' | 'board' | 'steps' | null;
  /** Snooze's own `due`, armed only while it is next. */
  snoozeDue: boolean;
}

/**
 * The load's latch (App): only `reveal.next` is armed. An older Inbox reports no queue (no `reveal`): its Snooze rule
 * alone, and never the Board.
 */
export function revealArmed(settings: { reveal?: { next: RevealArmed['next'] }; snooze_intro?: { due: boolean } }): RevealArmed {
  const snoozeDue = settings.snooze_intro?.due === true;
  const next = settings.reveal ? settings.reveal.next : snoozeDue ? 'snooze' : null;
  return { next, snoozeDue: snoozeDue && next === 'snooze' };
}

/** The Board reveal's need: the list holds this many rows or more (the approval: "the list has 5 rows or more"). */
export const BOARD_REVEAL_MIN_ROWS = 5;

/** What one load knows for the Board reveal (read once: `due`) and what holds now. */
export interface BoardRevealInput {
  /** The Inbox has the Board next for this page (settings `reveal.next === 'board'`), read once per load. */
  due: boolean;
  listLoaded: boolean;
  firstRun: boolean;
  /** The tour, an update or another one-time dialog was on screen (or due) on this load. */
  blocked: boolean;
  rows: readonly InboxListRow[];
  toast: boolean;
  thread: string | null;
  clear: boolean;
  place: string;
  heldBack: () => boolean;
  /** The claim was granted: the Inbox turned the Board on (the sidebar's row appears with the dialog). */
  onBoardOn: () => void;
}

/**
 * Leaving a thread counts for the Board when it was open long enough to read and the person went back to the list
 * (not on to another thread).
 */
export function boardRevealLeaveCounts(visit: RevealVisit, now: number, next: string | null): boolean {
  return next === null && now - visit.at >= REVEAL_TIMES.readMs;
}

/** At a settled moment: the list is loaded and not the first-run screen, the page old enough, and the list long enough. */
export function boardRevealMayClaim(gate: Pick<BoardRevealInput, 'due' | 'blocked' | 'listLoaded' | 'firstRun' | 'rows'>, pageAge: number): boolean {
  if (!gate.due || gate.blocked || !gate.listLoaded || gate.firstRun) return false;
  return pageAge >= REVEAL_TIMES.pageAgeMs && gate.rows.length >= BOARD_REVEAL_MIN_ROWS;
}

/**
 * The Board reveal: at the calm moment it claims `board` (the claim turns the Board on), then opens the Board's
 * existing first-visit dialog (`BoardIntro`). No new dialog (the owner, 2026-11-03).
 */
export function useBoardReveal(input: BoardRevealInput) {
  const latest = useRef(input);
  latest.current = input;
  return useRevealMoment({
    wanted: input.due && !input.blocked,
    thread: input.thread,
    rows: input.rows,
    clear: input.clear,
    place: input.place,
    heldBack: input.heldBack,
    toast: input.toast,
    leaveCounts: (visit, now, _row, next) => boardRevealLeaveCounts(visit, now, next),
    mayClaim: (pageAge) => boardRevealMayClaim(latest.current, pageAge),
    holds: () => true,
    claim: async () => {
      const answer = await inboxApi.claimReveal('board');
      // Granted here, or by another tab or device first: the Board is on either way, so its row shows now.
      if (answer.show || answer.board?.on) latest.current.onBoardOn();
      return answer.show;
    },
  });
}

/** What one load knows for the Checklist reveal: the Board's, but its claim turns the Checklist on. */
export interface StepsRevealInput extends Omit<BoardRevealInput, 'onBoardOn'> {
  /** The claim was granted (or another tab's was): the Inbox turned the Checklist on. */
  onStepsOn: () => void;
}

/**
 * The Checklist reveal (proposal; its queue entry is off until approved): the Board's calm moment and gate (back on
 * the list after reading a thread, 60 s into the page, 5 rows or more). The claim turns the Checklist on, then the
 * page opens `ChecklistIntro`.
 */
export function useStepsReveal(input: StepsRevealInput) {
  const latest = useRef(input);
  latest.current = input;
  return useRevealMoment({
    wanted: input.due && !input.blocked,
    thread: input.thread,
    rows: input.rows,
    clear: input.clear,
    place: input.place,
    heldBack: input.heldBack,
    toast: input.toast,
    leaveCounts: (visit, now, _row, next) => boardRevealLeaveCounts(visit, now, next),
    mayClaim: (pageAge) => boardRevealMayClaim(latest.current, pageAge),
    holds: () => true,
    claim: async () => {
      const answer = await inboxApi.claimReveal('steps');
      if (answer.show || answer.steps?.on) latest.current.onStepsOn();
      return answer.show;
    },
  });
}
