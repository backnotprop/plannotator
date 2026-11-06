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
 * claim already stamped it (a claim whose answer was lost is sent again with the same key: `claimRevealOnce`). A claim
 * turns nothing on (the owner, 2026-11-04: reveals are opt-in); a feature's dialog offers "Turn it on" and "Not now",
 * and never opens once the settings say the feature is on.
 */
import { useEffect, useRef, useState } from 'react';
import type { InboxListRow, InboxThread } from '@plannotator/core/inbox-types';
import { InboxApiError, inboxApi, type InboxRevealClaimId, type InboxRevealId } from './api';
import { LIST_INTRO_SETTLED_MS } from './listIntro';
import { newUuid } from './uuid';

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
  /** A claim whose answer was lost (a network error) is sent again, once, after this long. */
  claimRetryMs: 1_500,
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

/**
 * Never while a question waits in the open thread (approval "inbox-one-time-dialogs"): the thread open now has an open
 * question or action item for the person. Every one-time dialog of the Inbox holds back on it.
 */
export function openThreadAsks(rows: readonly InboxListRow[], thread: string | null): boolean {
  if (!thread) return false;
  const row = rows.find((r) => r.thread_id === thread);
  return !!row && !row.snoozed && row.questions.open > 0;
}

/** What a dialog's moment may read about a thread the person had open: who wrote how much. */
export interface RevealThreadFacts {
  /** The most messages one agent session wrote in it. */
  mostFromOneAgent: number;
  /** Words in its last agent message. */
  lastAgentWords: number;
}

const threadFacts = new Map<string, RevealThreadFacts>();

/** A thread as the window loaded it: its facts are kept for the moment its leave makes (App calls this). */
export function noteRevealThread(thread: InboxThread): void {
  const counts = new Map<string, number>();
  let lastAgentWords = 0;
  for (const message of thread.messages) {
    if (message.author.kind !== 'agent') continue;
    const who = `${message.author.host ?? ''}\0${message.author.session ?? message.author.name ?? ''}`;
    counts.set(who, (counts.get(who) ?? 0) + 1);
    const body = message.body.trim();
    lastAgentWords = body === '' ? 0 : body.split(/\s+/).length;
  }
  threadFacts.set(thread.thread_id, { mostFromOneAgent: Math.max(0, ...counts.values()), lastAgentWords });
}

/** What the window knows of a thread it loaded on this page, or null. */
export function revealThreadFactsOf(threadId: string): RevealThreadFacts | null {
  return threadFacts.get(threadId) ?? null;
}

/** What a load arms, read once from settings: the reveal that is next, and whether that is Snooze's announcement. */
export interface RevealArmed {
  next: InboxRevealId | null;
  /** Snooze's own `due`, armed only while it is next. */
  snoozeDue: boolean;
  /** The offers this load may also arm, each at its own moment (settings `reveal.ahead`: List view). */
  ahead: readonly InboxRevealId[];
}

/**
 * The load's latch (App): only `reveal.next` is armed. An older Inbox reports no queue (no `reveal`): its Snooze rule
 * alone, and never the Board.
 */
export function revealArmed(settings: { reveal?: { next: RevealArmed['next']; ahead?: readonly InboxRevealId[] }; snooze_intro?: { due: boolean } }): RevealArmed {
  const snoozeDue = settings.snooze_intro?.due === true;
  const next = settings.reveal ? settings.reveal.next : snoozeDue ? 'snooze' : null;
  return { next, snoozeDue: snoozeDue && next === 'snooze', ahead: settings.reveal?.ahead ?? [] };
}

/** The Board reveal's need: the list holds this many rows or more (the approval: "the list has 5 rows or more"). */
export const BOARD_REVEAL_MIN_ROWS = 5;
/** And they are in this many projects or more (approval "inbox-one-time-dialogs": "5+ open threads, 2+ projects"). */
export const BOARD_REVEAL_MIN_PROJECTS = 2;
/** The Checklist's moment: the thread just left has this many messages or more from one agent ("a long agent run"). */
export const STEPS_REVEAL_MIN_RUN = 5;

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
  /** The settings say the Board is on (live, `event: capabilities`): the offer no longer opens. */
  on?: boolean;
  /** The claim's answer says the Board is on (another tab or device turned it on): the sidebar's row shows now. */
  onBoardOn: () => void;
}

type RevealClaimAnswer = Awaited<ReturnType<typeof inboxApi.claimReveal>>;

/**
 * Claim a reveal, safe to repeat: the page's `key` goes with it and the Inbox keeps it with the stamp, so a claim whose
 * answer was lost (the phone's network dropped after the Inbox stamped it) is sent again, once, and is shown it again.
 * An answer from the Inbox (any status) is final; another window's or device's key still gets `show: false`.
 */
export async function claimRevealOnce(id: InboxRevealClaimId, key: string): Promise<RevealClaimAnswer> {
  try {
    return await inboxApi.claimReveal(id, key);
  } catch (cause) {
    if (cause instanceof InboxApiError) throw cause;
    await new Promise((resolve) => setTimeout(resolve, REVEAL_TIMES.claimRetryMs));
    return inboxApi.claimReveal(id, key);
  }
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
  if (pageAge < REVEAL_TIMES.pageAgeMs || gate.rows.length < BOARD_REVEAL_MIN_ROWS) return false;
  return new Set(gate.rows.map((row) => row.project.id)).size >= BOARD_REVEAL_MIN_PROJECTS;
}

/** The Checklist's own gate: the Board's, without its two projects (approval "inbox-checklist-reveal": 5 rows). */
function stepsRevealMayClaim(gate: Pick<BoardRevealInput, 'due' | 'blocked' | 'listLoaded' | 'firstRun' | 'rows'>, pageAge: number): boolean {
  if (!gate.due || gate.blocked || !gate.listLoaded || gate.firstRun) return false;
  return pageAge >= REVEAL_TIMES.pageAgeMs && gate.rows.length >= BOARD_REVEAL_MIN_ROWS;
}

/**
 * Leaving a thread counts for the Checklist when the Board's leave does and one agent sent `STEPS_REVEAL_MIN_RUN`
 * messages or more in it (approval "inbox-one-time-dialogs": "just left a thread where one agent sent 5+ messages").
 */
export function stepsRevealLeaveCounts(visit: RevealVisit, now: number, next: string | null): boolean {
  return boardRevealLeaveCounts(visit, now, next) && (revealThreadFactsOf(visit.threadId)?.mostFromOneAgent ?? 0) >= STEPS_REVEAL_MIN_RUN;
}

/**
 * The Board reveal: at the calm moment it claims `board` (the claim only stamps it), then opens the Board's existing
 * first-visit dialog (`BoardIntro`) as an offer: "Turn it on" or "Not now" (the owner, 2026-11-04: opt-in).
 */
export function useBoardReveal(input: BoardRevealInput) {
  const latest = useRef(input);
  latest.current = input;
  const key = useRef<string | null>(null);
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
    // Turned on meanwhile (Settings here, or another window or device): the offer no longer applies.
    holds: () => !latest.current.on,
    claim: async () => {
      key.current ??= newUuid();
      const answer = await claimRevealOnce('board', key.current);
      // The claim turns nothing on; the answer only reports a Board turned on elsewhere, so its row shows now.
      if (answer.board?.on) latest.current.onBoardOn();
      return answer.show;
    },
  });
}

/** What one load knows for the Checklist reveal: the Board's (`on`: the settings say the Checklist is on). */
export interface StepsRevealInput extends Omit<BoardRevealInput, 'onBoardOn'> {
  /** The claim's answer says the Checklist is on (another tab or device turned it on). */
  onStepsOn: () => void;
}

/**
 * The Checklist reveal (approval "inbox-checklist-reveal", 2026-11-04): the Board's calm moment and gate (back on
 * the list after reading a thread, 60 s into the page, 5 rows or more), and the thread just left was a long agent run
 * (approval "inbox-one-time-dialogs"). The claim only stamps it; the page opens `ChecklistIntro`, whose "Turn it on"
 * turns the Checklist on.
 */
export function useStepsReveal(input: StepsRevealInput) {
  const latest = useRef(input);
  latest.current = input;
  const key = useRef<string | null>(null);
  return useRevealMoment({
    wanted: input.due && !input.blocked,
    thread: input.thread,
    rows: input.rows,
    clear: input.clear,
    place: input.place,
    heldBack: input.heldBack,
    toast: input.toast,
    leaveCounts: (visit, now, _row, next) => stepsRevealLeaveCounts(visit, now, next),
    mayClaim: (pageAge) => stepsRevealMayClaim(latest.current, pageAge),
    holds: () => !latest.current.on,
    claim: async () => {
      key.current ??= newUuid();
      const answer = await claimRevealOnce('steps', key.current);
      if (answer.steps?.on) latest.current.onStepsOn();
      return answer.show;
    },
  });
}

/** What a registered offer of the line brings: its id, its moment and its need (the line does the rest). */
export interface LineRevealInput {
  /** Its id in the line (`INBOX_REVEALS`, and `lineOffers` on the server). */
  id: Exclude<InboxRevealClaimId, 'snooze' | 'agent_note'>;
  /**
   * The Inbox has it for this page, read once per load: `reveal.next === id`, or (an `ahead` offer such as List view)
   * `reveal.ahead` names it, so it goes at its own moment even while another offer is next.
   */
  due: boolean;
  /** The tour, an update or another one-time dialog was on screen (or due) on this load. */
  blocked: boolean;
  thread: string | null;
  rows: readonly InboxListRow[];
  clear: boolean;
  place: string;
  /** Something typed or open over the page, or a question waiting in the open thread (App's `oneTimeHeldBack`). */
  heldBack: () => boolean;
  toast: boolean;
  /** Its moment: leaving `visit` (its row now) for `next` (null: back on the list). */
  leaveCounts: (visit: RevealVisit, now: number, row: InboxListRow | null, next: string | null) => boolean;
  /** Its need at a settled moment (the list, the page's age). */
  mayClaim: (pageAge: number) => boolean;
  /** Still worth showing (its feature not turned on meanwhile). */
  holds: () => boolean;
}

/**
 * A registered offer of the line (approval "inbox-one-time-dialogs"; Bro mode and List view register this way): its
 * own moment and need, the shared calm moment (`useRevealMoment`), and the line's claim (`POST /api/inbox/reveal`,
 * safe to repeat with the page's key). Its dialog's Not now calls `inboxApi.revealNotNow(id)`.
 */
export function useLineReveal(input: LineRevealInput) {
  const latest = useRef(input);
  latest.current = input;
  const key = useRef<string | null>(null);
  return useRevealMoment({
    wanted: input.due && !input.blocked,
    thread: input.thread,
    rows: input.rows,
    clear: input.clear,
    place: input.place,
    heldBack: input.heldBack,
    toast: input.toast,
    leaveCounts: (visit, now, row, next) => latest.current.leaveCounts(visit, now, row, next),
    mayClaim: (pageAge) => latest.current.mayClaim(pageAge),
    holds: () => latest.current.holds(),
    claim: async () => {
      key.current ??= newUuid();
      return (await claimRevealOnce(latest.current.id, key.current)).show;
    },
  });
}

/**
 * List view's moment, as registered with the line (approval "inbox-one-time-dialogs", the change): leaving a thread
 * for the list itself (not for another thread).
 */
export function listViewRevealLeaveCounts(next: string | null): boolean {
  return next === null;
}

/** What List view's need reads at a settled moment. */
export interface ListViewRevealGate {
  listLoaded: boolean;
  firstRun: boolean;
  /** The list draws its groups (Smart groups): the choice is for someone who has not picked Simple list. */
  grouped: boolean;
  /** The list on screen is taller than the screen (`listTallerThanScreen`). */
  taller: boolean;
}

/**
 * List view's need (approval "inbox-one-time-dialogs": "once the person's list has grown taller than the screen, on
 * Grouped, at the next calm moment"): the list loaded and not the first-run screen, the page old enough, on Smart
 * groups, and taller than the screen. The line decides the day (`reveal.next`, or `reveal.ahead` at its moment).
 */
export function listViewRevealMayClaim(gate: ListViewRevealGate, pageAge: number): boolean {
  return gate.listLoaded && !gate.firstRun && gate.grouped && gate.taller && pageAge >= REVEAL_TIMES.pageAgeMs;
}

/** The list's scrolling body holds more than it shows: the list is taller than the screen. */
export function listTallerThanScreen(body: Element | null): boolean {
  return body !== null && body.scrollHeight > body.clientHeight;
}
