/**
 * Who the Routines intro is for (reveals.ts `routines`; the owner, 2026-11-17: "Once we have at least like three days
 * of good usage from a user, we should introduce routines, or if they've already been here for three days, show them
 * the routines dialogue"). Pure, so a test can hand it any history; the Inbox server (packages/server/inbox.ts) reads it
 * live on every settings read, while the dialog is unshown on a release build. The walk of the store runs only once the
 * intro's tenure is over (`routinesIntroWaits`), and once it finds three good days it is never walked again.
 *
 * "Three days of good use": the person sent something on `ROUTINES_INTRO_GOOD_DAYS` different local calendar days,
 * with `ROUTINES_INTRO_SENDS_PER_DAY` sends or more on each, any time in their history. A send is one of the person's
 * own messages in this machine's store (a reply or a new message, from the window, the phone or a linked machine's
 * forward, all written here). The Inbox's own notes (a 👍 Looks good's ack, a set-aside note, a skip line) and a
 * routine's run dividers are not sends. No new telemetry and never the anonymous ping: only what the store holds.
 * Someone who was already here when it shipped qualifies from their history.
 */
import { isInboxNote } from "@plannotator/core/inbox-types";
import { INBOX_REVEALS, revealDay, type RevealState } from "./reveals";

/** Different local days with enough sends. */
export const ROUTINES_INTRO_GOOD_DAYS = 3;
/** Sends on one local day for it to count. */
export const ROUTINES_INTRO_SENDS_PER_DAY = 2;

/** A message as the rule reads it (a store message has every field). */
export interface RoutinesIntroMessage {
  author: { kind: string };
  created_at: string;
  set_aside?: readonly string[] | null;
  reopened?: readonly string[] | null;
  ack_of?: string | null;
  tidy?: unknown;
  scheduled_run?: { run?: number } | null;
}

/** The message is one of the person's own sends: their words, not an Inbox note or a routine's run divider. */
export function routinesIntroSend(message: RoutinesIntroMessage): boolean {
  if (message.author.kind !== "person" || message.scheduled_run) return false;
  return !isInboxNote(message as Parameters<typeof isInboxNote>[0]);
}

/**
 * Three good days in these sends' times (ISO strings, any order). Stops reading at the third good day, so a long
 * history costs only what it takes to find them.
 */
export function routinesIntroGoodDays(sends: Iterable<string>): boolean {
  const perDay = new Map<string, number>();
  let good = 0;
  for (const iso of sends) {
    const at = Date.parse(iso);
    if (Number.isNaN(at)) continue;
    const day = revealDay(at);
    const count = (perDay.get(day) ?? 0) + 1;
    perDay.set(day, count);
    if (count === ROUTINES_INTRO_SENDS_PER_DAY && ++good >= ROUTINES_INTRO_GOOD_DAYS) return true;
  }
  return false;
}

/**
 * Three good days, walking the store until they are found once. Sends only add up, so a true is kept and never walked
 * again; a false is walked again at the next read.
 */
export function routinesIntroGoodDaysOnce(sends: () => Iterable<string>): () => boolean {
  let found = false;
  return () => (found ||= routinesIntroGoodDays(sends()));
}

/**
 * The walk can wait: the line refuses the intro whatever the walk would find (reveals.ts `revealQualifies`): first use
 * unknown or under its tenure (its first two days). Meanwhile it is reported open without the walk, so the line still
 * names the moment it could go (`revealAgainAt`: the end of its tenure), and the walk decides then.
 */
export function routinesIntroWaits(state: Pick<RevealState, "firstUseAt">, now: Date): boolean {
  const tenure = INBOX_REVEALS.find((entry) => entry.id === "routines")?.tenureMs ?? 0;
  const first = state.firstUseAt ? Date.parse(state.firstUseAt) : Number.NaN;
  return Number.isNaN(first) || now.getTime() - first < tenure;
}

/** What the server knows, each read lazily and in this order (the walk of the store last). */
export interface RoutinesIntroFacts {
  /** Routines are offered on this computer (never on Windows). */
  supported: boolean;
  /** config.json `inboxScheduledThreads`: `true` or `false` is the person's decision; unset, never decided. */
  saved: () => boolean | undefined;
  /** A routine record exists here (deleted ones too): the person, or an agent for them, already met the feature. */
  routineMade: () => boolean;
  /** "Start agents from New message" is on: a run is a launch, and someone who turned launches off said no to that. */
  launchOn: () => boolean;
  /** The line would refuse it anyway, under its tenure (`routinesIntroWaits`): open without the walk. Absent: always walk. */
  waits?: () => boolean;
  /** Three good days of the person's own sends (`routinesIntroGoodDaysOnce` over `routinesIntroSend`): the walk. */
  goodDays: () => boolean;
}

/** The intro is open for this person: offered, undecided, no routine yet, launches on, and three good days. */
export function routinesIntroOpen(facts: RoutinesIntroFacts): boolean {
  if (!facts.supported || facts.saved() !== undefined || facts.routineMade() || !facts.launchOn()) return false;
  return facts.waits?.() === true || facts.goodDays();
}
