/**
 * The queue of one-time feature reveals for people who come back (approval "inbox-feature-reveal", 2026-11-03): Snooze
 * (its announcement), then the Board, then thread steps. Pure, so a test can move the clock; the Inbox server
 * (packages/server/inbox.ts) builds the state from config.json and the store, reports `revealNext` to the page
 * (`GET /api/inbox/settings` `reveal.next`) and spends the claim with `revealMayClaim` (`POST /api/inbox/reveal`).
 *
 * The rules:
 *  - One due at a time: the first entry, in table order, whose "who" holds (a release build, tenure since first use,
 *    enough threads, its own conditions) while the spacing holds.
 *  - Spacing: never two reveals within `REVEAL_SPACING_MS` (48 h) on one machine. Every one-time announcement stamps
 *    `inboxReveals.lastShownAt` when it is claimed (list options, voice, Snooze, the Board), and the clock also reads
 *    the announcements' own `shownAt` stamps from before that key existed (`revealLastShown`), so each counts.
 *  - Patience: an entry that has been next for `REVEAL_PATIENCE_MS` (3 days) without its moment lets the next entry
 *    that qualifies go first. It stays in line: when every qualifying entry has waited that long, the one that has
 *    waited longest is next.
 *  - No active-days counter.
 */

export type RevealId = "snooze" | "board" | "steps";

const DAY_MS = 24 * 60 * 60 * 1000;

export interface RevealEntry {
  id: RevealId;
  /** First use must be at least this long ago. */
  tenureMs: number;
  /** The machine must hold at least this many threads (roots in the store). */
  minThreads: number;
  /** Off: never next and never claimed. */
  enabled: boolean;
}

/** The queue, in order. */
export const INBOX_REVEALS: readonly RevealEntry[] = [
  // Its own rules stay (packages/server/inbox-snooze-intro.ts); the queue adds the spacing.
  { id: "snooze", tenureMs: 2 * DAY_MS, minThreads: 0, enabled: true },
  // The owner: "ok board can be 3 days, snooze 2". The claim turns the Board on (inboxBoard unset -> true).
  { id: "board", tenureMs: 3 * DAY_MS, minThreads: 5, enabled: true },
  // The Checklist (thread steps): proposed, not approved (.ops/research/checklist-reveal, `ChecklistIntro`). Five days
  // and the Board's five threads; the claim would turn the Checklist on (inboxSteps unset -> true). Off until the owner
  // approves it: never next, never claimed, and no word of it reaches an agent.
  { id: "steps", tenureMs: 5 * DAY_MS, minThreads: 5, enabled: false },
];

/** Never two reveals within this long on one machine. */
export const REVEAL_SPACING_MS = 48 * 60 * 60 * 1000;
/** An entry next this long without its moment lets the next one go first. */
export const REVEAL_PATIENCE_MS = 3 * DAY_MS;

/** What the server knows. Every time is an ISO string. */
export interface RevealState {
  release: boolean;
  /** The person's first use of the Inbox (config.json `inboxSnoozeIntro.firstUseAt`). */
  firstUseAt?: string | null;
  /** The last one-time announcement claimed on this machine (config.json `inboxReveals.lastShownAt`). */
  lastShownAt?: string | null;
  /** Threads on this machine. */
  threads: number;
  /** Per entry: its own conditions hold (not shown yet; its feature never decided by the person). Absent: false. */
  open: Partial<Record<RevealId, boolean>>;
  /** Per entry: when it first became next (config.json `inboxReveals.waitingSince`). Patience counts from it. */
  waitingSince?: Partial<Record<RevealId, string>>;
}

const time = (iso: string | null | undefined): number | null => {
  if (!iso) return null;
  const at = Date.parse(iso);
  return Number.isNaN(at) ? null : at;
};

/** The spacing holds: no announcement claimed within `REVEAL_SPACING_MS`. */
export function revealSpaced(lastShownAt: string | null | undefined, now: Date): boolean {
  const last = time(lastShownAt);
  return last === null || now.getTime() - last >= REVEAL_SPACING_MS;
}

/** The entry's "who" holds (the spacing apart). */
export function revealQualifies(entry: RevealEntry, state: RevealState, now: Date): boolean {
  if (!entry.enabled || !state.release || state.open[entry.id] !== true) return false;
  const first = time(state.firstUseAt);
  if (first === null || now.getTime() - first < entry.tenureMs) return false;
  return state.threads >= entry.minThreads;
}

/**
 * The reveal a page may arm now, or null: the first qualifying entry that has not waited out its patience. When every
 * qualifying entry has (none found its moment in 3 days), the one that has waited longest goes, so a stuck entry never
 * replaces the one it passed for good.
 */
export function revealNext(state: RevealState, now: Date): RevealId | null {
  if (!revealSpaced(state.lastShownAt, now)) return null;
  let longest: { id: RevealId; since: number } | null = null;
  for (const entry of INBOX_REVEALS) {
    if (!revealQualifies(entry, state, now)) continue;
    const since = time(state.waitingSince?.[entry.id]);
    if (since === null || now.getTime() - since < REVEAL_PATIENCE_MS) return entry.id;
    if (!longest || since < longest.since) longest = { id: entry.id, since };
  }
  return longest?.id ?? null;
}

/**
 * The spacing clock: the latest of the stamps given (the reveals' own `lastShownAt` and every one-time announcement's
 * `shownAt` from before it existed). Null when none is a time.
 */
export function revealLastShown(stamps: readonly (string | null | undefined)[]): string | null {
  let latest: number | null = null;
  for (const stamp of stamps) {
    const at = time(stamp);
    if (at !== null && (latest === null || at > latest)) latest = at;
  }
  return latest === null ? null : new Date(latest).toISOString();
}

/** A claim for `id` may be spent now: it is still next. A page that armed something else gets no. */
export function revealMayClaim(id: RevealId, state: RevealState, now: Date): boolean {
  return revealNext(state, now) === id;
}
