/**
 * The line of the Inbox's one-time dialogs (approval "inbox-feature-reveal", 2026-11-03; the schedule, approval
 * "inbox-one-time-dialogs", 2026-11-06, `.product/approved/inbox-one-time-dialogs/`). Pure, so a test can move the
 * clock; the Inbox server (packages/server/inbox.ts) builds the state from config.json and the store, reports
 * `revealNext` to the page (`GET /api/inbox/settings` `reveal.next`, and `reveal.setup` for the agent note) and spends
 * every claim against it.
 *
 * In the line, in this order: the update-day dialogs (the sound, list options, voice), then the offers (Snooze, the
 * Board, the Checklist). The agent note is a setup dialog: never in the queue, but it keeps the day and the page-load
 * rules (`revealLineFree("setup")`). The tour and the notification ask are not in the line: day 0 is theirs.
 *
 * The rules:
 *  - Day 0 is setup only: every offer needs tenure (two days or more since first use).
 *  - One due at a time: the first entry, in table order, whose "who" holds (a release build, tenure since first use,
 *    enough threads, heavy use where it asks for it, its own conditions).
 *  - At most one new dialog a calendar day (local time), the agent note included (`inboxReveals.dayShownAt`).
 *  - Never on two page loads in a row: the load right after the one that showed the last dialog shows none
 *    (`revealAfterShowLoad`; each page sends its load id).
 *  - Spacing: `REVEAL_SPACING_MS` (2 days) after the last dialog that stamps the clock (every one but the agent note),
 *    `REVEAL_NOT_NOW_SPACING_MS` (4 days) after an offer closed with Not now (`inboxReveals.notNowAt`). The clock also
 *    reads the announcements' own `shownAt` stamps from before that key existed (`revealLastShown`).
 *  - Patience: an entry that has been next for `REVEAL_PATIENCE_MS` (3 days) without its moment lets the next entry
 *    that qualifies go first. It stays in line: when every qualifying entry has waited that long, the one that has
 *    waited longest is next.
 *  - Retirement: an entry next for `REVEAL_RETIRE_MS` (14 days) without its moment retires without a word.
 *  - No active-days counter (the owner, 2026-11-02): "different days" for heavy use come from the dates of the agent
 *    messages the person has read.
 *
 * Registering a dialog (a branch's Bro mode or List view): add its entry to `INBOX_REVEALS` at its place, with its own
 * need (`tenureMs`, `minThreads`, `heavyUse`); in packages/server/inbox.ts, add its "undecided" to `lineOffers` (the
 * claim, the stamp, Not now and retirement then come from the line); on the page, arm it from `reveal.next` with
 * `useLineReveal` (packages/inbox/reveal.ts) and its own moment. docs/agent-guides/inbox-window.md has the steps.
 */

/** Every dialog the queue orders. A registered dialog adds its id here. */
export type RevealId = "sound" | "list_intro" | "voice" | "snooze" | "board" | "steps";
/** Every dialog that keeps the line's day: the queue's, and the agent note (setup). */
export type LineDialogId = RevealId | "agent_note";

/**
 * `update`: an update-day dialog for someone who used an earlier Inbox (who it is for is decided at a release start);
 * it may show on the person's first day (an update day is its own day 0). `offer`: needs tenure.
 */
export type RevealKind = "update" | "offer";

const DAY_MS = 24 * 60 * 60 * 1000;

export interface RevealEntry {
  id: RevealId;
  kind: RevealKind;
  /** First use must be at least this long ago. An update-day dialog with no first use known waits for nothing. */
  tenureMs: number;
  /** The machine must hold at least this many threads (roots in the store). */
  minThreads: number;
  /** Heavy use must hold (`revealHeavyUse`): for offers that only a heavy user needs (Bro mode). */
  heavyUse?: boolean;
  /** Off: never next and never claimed. */
  enabled: boolean;
}

/** The queue, in order. */
export const INBOX_REVEALS: readonly RevealEntry[] = [
  // The update-day dialogs (who: config.json `inboxSound`, `inboxListIntro`, `inboxVoiceIntro`), one a day and two
  // days apart: the sound on the update day, list options two days later, voice two after that.
  { id: "sound", kind: "update", tenureMs: 0, minThreads: 0, enabled: true },
  { id: "list_intro", kind: "update", tenureMs: 0, minThreads: 0, enabled: true },
  { id: "voice", kind: "update", tenureMs: 0, minThreads: 0, enabled: true },
  // Its own rules stay (packages/server/inbox-snooze-intro.ts); the queue adds the spacing.
  { id: "snooze", kind: "offer", tenureMs: 2 * DAY_MS, minThreads: 0, enabled: true },
  // Bro mode (#2693) goes here: { id: "bro", kind: "offer", tenureMs: 2 * DAY_MS, minThreads: 0, heavyUse: true, enabled: true }.
  // The owner: "ok board can be 3 days, snooze 2". Opt-in (the owner, 2026-11-04): the claim only stamps it; the
  // dialog's "Turn it on" writes inboxBoard (unset -> true), "Not now" leaves it unset.
  { id: "board", kind: "offer", tenureMs: 3 * DAY_MS, minThreads: 5, enabled: true },
  // The Checklist (thread steps), approval "inbox-checklist-reveal" (2026-11-04): 5 days ("lands around day 6") and the
  // Board's 5 threads; the Board need not be on. Opt-in, as the Board: the claim only stamps it, `ChecklistIntro` opens,
  // and only its "Turn it on" writes inboxSteps (unset -> true). Until then no word of it reaches an agent.
  { id: "steps", kind: "offer", tenureMs: 5 * DAY_MS, minThreads: 5, enabled: true },
  // List view (#2716) goes here: { id: "list_view", kind: "offer", tenureMs: 2 * DAY_MS, minThreads: 0, enabled: true }.
];

/** Never two dialogs within this long on one machine (the agent note apart). */
export const REVEAL_SPACING_MS = 48 * 60 * 60 * 1000;
/** After an offer closed with Not now, the next waits this long. */
export const REVEAL_NOT_NOW_SPACING_MS = 4 * DAY_MS;
/** An entry next this long without its moment lets the next one go first. */
export const REVEAL_PATIENCE_MS = 3 * DAY_MS;
/** An entry next this long without its moment retires. */
export const REVEAL_RETIRE_MS = 14 * DAY_MS;
/** Heavy use: this many threads read in the window, on this many different days. */
export const REVEAL_HEAVY_USE = { threads: 10, windowMs: 7 * DAY_MS, days: 2 } as const;

/** What the server knows. Every time is an ISO string. */
export interface RevealState {
  release: boolean;
  /** The person's first use of the Inbox (config.json `inboxSnoozeIntro.firstUseAt`). */
  firstUseAt?: string | null;
  /** The last dialog that stamps the spacing clock on this machine (config.json `inboxReveals.lastShownAt`). */
  lastShownAt?: string | null;
  /** The last dialog of any kind in the line, the agent note included (config.json `inboxReveals.dayShownAt`). */
  dayShownAt?: string | null;
  /** The last offer closed with Not now (config.json `inboxReveals.notNowAt`). */
  notNowAt?: string | null;
  /** This page's load comes right after the load that showed the last dialog (`revealAfterShowLoad`). */
  afterShowLoad?: boolean;
  /** Heavy use holds (`revealHeavyUse`). Absent: false. */
  heavy?: boolean;
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

/** The local calendar day of a time, as a key. */
export function revealDay(at: number): string {
  const d = new Date(at);
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

/** The spacing holds: two days since the last dialog that stamps the clock, four since a Not now. */
export function revealSpaced(lastShownAt: string | null | undefined, now: Date, notNowAt?: string | null): boolean {
  const last = time(lastShownAt);
  if (last !== null && now.getTime() - last < REVEAL_SPACING_MS) return false;
  const notNow = time(notNowAt);
  return notNow === null || now.getTime() - notNow >= REVEAL_NOT_NOW_SPACING_MS;
}

/** No dialog of the line was shown today (local calendar day). */
export function revealDayFree(state: Pick<RevealState, "lastShownAt" | "dayShownAt">, now: Date): boolean {
  const today = revealDay(now.getTime());
  return [state.lastShownAt, state.dayShownAt].every((stamp) => {
    const at = time(stamp);
    return at === null || revealDay(at) !== today;
  });
}

/**
 * The line's own rules, for any dialog in it: not on the load right after the one that showed the last dialog, not on
 * a day that already had one, and (except the agent note, `setup`) the spacing. A dev build keeps no line: free.
 */
export function revealLineFree(kind: "setup" | "spaced", state: RevealState, now: Date): boolean {
  if (!state.release) return true;
  if (state.afterShowLoad || !revealDayFree(state, now)) return false;
  return kind === "setup" || revealSpaced(state.lastShownAt, now, state.notNowAt);
}

/** The entry has been next so long without its moment that it retires. */
export function revealRetired(id: RevealId, state: Pick<RevealState, "waitingSince">, now: Date): boolean {
  const since = time(state.waitingSince?.[id]);
  return since !== null && now.getTime() - since >= REVEAL_RETIRE_MS;
}

/** The entry's "who" holds (the line's rules apart). */
export function revealQualifies(entry: RevealEntry, state: RevealState, now: Date): boolean {
  if (!entry.enabled || !state.release || state.open[entry.id] !== true) return false;
  if (entry.heavyUse && state.heavy !== true) return false;
  if (revealRetired(entry.id, state, now)) return false;
  const first = time(state.firstUseAt);
  if (first === null) {
    if (entry.kind !== "update") return false;
  } else if (now.getTime() - first < entry.tenureMs) return false;
  return state.threads >= entry.minThreads;
}

/**
 * The dialog a page may arm now, or null: the first qualifying entry that has not waited out its patience, while the
 * line is free. When every qualifying entry has (none found its moment in 3 days), the one that has waited longest
 * goes, so a stuck entry never replaces the one it passed for good. `table`: the queue (a test can register more).
 */
export function revealNext(state: RevealState, now: Date, table: readonly RevealEntry[] = INBOX_REVEALS): RevealId | null {
  if (!revealLineFree("spaced", state, now)) return null;
  let longest: { id: RevealId; since: number } | null = null;
  for (const entry of table) {
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
export function revealMayClaim(id: RevealId, state: RevealState, now: Date, table: readonly RevealEntry[] = INBOX_REVEALS): boolean {
  return revealNext(state, now, table) === id;
}

/**
 * Heavy use (Bro mode's need, approval "inbox-one-time-dialogs"): `REVEAL_HEAVY_USE.threads` threads or more read in
 * the last 7 days, on 2 different days or more. `reads`: each agent message the person has looked at (its thread and
 * when it was written); its date stands for the day it was read, so no visit is counted anywhere.
 */
export function revealHeavyUse(reads: Iterable<{ threadId: string; at: string }>, now: Date): boolean {
  const threads = new Set<string>();
  const days = new Set<string>();
  for (const read of reads) {
    const at = time(read.at);
    if (at === null || at > now.getTime() || now.getTime() - at > REVEAL_HEAVY_USE.windowMs) continue;
    threads.add(read.threadId);
    days.add(revealDay(at));
  }
  return threads.size >= REVEAL_HEAVY_USE.threads && days.size >= REVEAL_HEAVY_USE.days;
}

/** What config.json keeps for the line (`inboxReveals`), the fields this module writes. */
export interface RevealsSaved {
  lastShownAt?: string;
  dayShownAt?: string;
  notNowAt?: string;
  /** The load id of the page that showed the last dialog. */
  shownLoad?: string;
  waitingSince?: Partial<Record<RevealId, string>>;
}

/** A page's load id, as a page sends it (`X-Plannotator-Load`): 8 to 64 letters, digits, - or _. */
export function revealLoadId(value: string | null | undefined): string | null {
  return typeof value === "string" && /^[A-Za-z0-9_-]{8,64}$/.test(value) ? value : null;
}

/**
 * The last two page loads the Inbox saw (ids). Kept in memory, not in config.json: it changes on every load, and the
 * one-a-day rule already covers the load after a restart.
 */
export interface RevealLoads {
  current?: string;
  previous?: string;
}

/** The loads once this page load is seen: null when nothing changes (the same load again, or no id). */
export function revealSeeLoad(loads: RevealLoads, load: string | null): RevealLoads | null {
  if (!load || loads.current === load) return null;
  return { previous: loads.current, current: load };
}

/**
 * This load comes right after the load that showed the last dialog (`shownLoad`, saved with the stamp). A page that
 * sends no id is never held back.
 */
export function revealAfterShowLoad(shownLoad: string | undefined, loads: RevealLoads, load: string | null): boolean {
  if (!load || !shownLoad || loads.current !== load) return false;
  return loads.previous === shownLoad;
}

/**
 * The saved line once a dialog is shown at `at`: the day's stamp, the load that showed it and, unless it is the agent
 * note (`spaced: false`), the spacing clock.
 */
export function revealStamp<T extends RevealsSaved>(saved: T | undefined, at: string, opts: { spaced: boolean; load: string | null }): T {
  return {
    ...(saved ?? ({} as T)),
    dayShownAt: at,
    ...(opts.spaced ? { lastShownAt: at } : {}),
    ...(opts.load ? { shownLoad: opts.load } : {}),
  };
}

/** The saved line once an offer is closed with Not now: the next waits four days. */
export function revealStampNotNow<T extends RevealsSaved>(saved: T | undefined, at: string): T {
  return { ...(saved ?? ({} as T)), notNowAt: at };
}
