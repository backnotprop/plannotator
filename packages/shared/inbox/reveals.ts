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
 *  - Ahead at its moment: an offer marked `ahead` (List view: approval "inbox-one-time-dialogs", "the change") may also
 *    be armed while another offer is next, and goes as soon as its own moment comes, still inside the day, load and
 *    spacing rules (`revealAhead`). It never goes before an update-day dialog.
 *  - At most one new dialog a calendar day (local time), the agent note included (`inboxReveals.dayShownAt`).
 *  - Never on two page loads in a row: the load right after the one that showed the last dialog shows none
 *    (`revealAfterShowLoad`; each page sends its load id, and a load counts once, when it is first seen, so an old tab
 *    reading settings again never becomes the newest load).
 *  - Spacing (changed 2026-11-06: "one day apart, three after a Not now"): `REVEAL_SPACING_MS` (1 day) after the last
 *    dialog that stamps the clock (every one but the agent note; one clock, so the update-day dialogs keep it too),
 *    `REVEAL_NOT_NOW_SPACING_MS` (3 days) after an offer closed with Not now (`inboxReveals.notNowAt`; offers only, an
 *    update-day dialog's Not now keeps the 1 day). The clock also
 *    reads the announcements' own `shownAt` stamps from before that key existed (`revealLastShown`).
 *  - Patience: an entry that has been next for `REVEAL_PATIENCE_MS` (3 days) without its moment lets the next entry
 *    that qualifies go first. It stays in line: when every qualifying entry has waited that long, the one that has
 *    waited longest is next.
 *  - Retirement: an offer next for `REVEAL_RETIRE_MS` (14 days) without its moment retires without a word. An
 *    update-day dialog never retires (patience still lets the others pass it).
 *  - No active-days counter (the owner, 2026-11-02): "different days" for heavy use come from the dates of the agent
 *    messages the person has read.
 *
 * Registering a dialog (a branch's Bro mode or List view): add its entry to `INBOX_REVEALS` at its place, with its own
 * need (`tenureMs`, `minThreads`, `heavyUse`, `ahead`); in packages/server/inbox.ts, add its "undecided" to `lineOffers` (the
 * claim, the stamp, Not now and retirement then come from the line); on the page, arm it from `reveal.next` with
 * `useLineReveal` (packages/inbox/reveal.ts) and its own moment (also from `reveal.ahead` when it is `ahead`). docs/agent-guides/inbox-window.md has the steps.
 */

/** Every dialog the queue orders. A registered dialog adds its id here. */
export type RevealId = "sound" | "list_intro" | "voice" | "snooze" | "board" | "steps" | "star";
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
  /**
   * An offer that goes ahead of the offers before it once its moment comes (`revealAhead`): List view, whose moment
   * (the list taller than the screen) is itself the heavy use. Only for `offer`.
   */
  ahead?: boolean;
  /** First use must be on an earlier local calendar day (`revealDay`): from the second day of use. */
  laterDay?: boolean;
  /**
   * Outside the line's order (the star ask): never `next`, never passing or passed by an entry, never stamping the
   * line. It may be claimed at a calm moment while the line is free (`revealMayClaim`), so no other entry's day moves.
   */
  aside?: boolean;
  /** Off: never next and never claimed. */
  enabled: boolean;
}

/** The queue, in order. */
export const INBOX_REVEALS: readonly RevealEntry[] = [
  // The update-day dialogs (who: config.json `inboxSound`, `inboxListIntro`, `inboxVoiceIntro`), one a day (the line's
  // one-day spacing): the sound on the update day, then list options and voice on later days, each at its moment.
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
  // The "Star the repo" ask (approval "star-ask", 2026-11-06; packages/shared/star-ask.ts): last in the line, shown
  // from the second day of Inbox use (the owner, 2026-11-06: "Would rather show it on 2nd day of inbox use"; no thread
  // minimum), once across every surface (config.json `starAsk`). Aside from the line's order (the coordinator, for the
  // owner: no offer may lose its showing to it): it takes a calm moment while the line is free, and its claim stamps
  // only its own `inboxReveals.star`, so every other dialog keeps its day. Its claim runs the already-starred check
  // (gh) before it stamps anything; starred already, nothing shows.
  { id: "star", kind: "offer", tenureMs: 0, minThreads: 0, laterDay: true, aside: true, enabled: true },
  // List view (#2716) goes here, last in order but ahead at its moment (`ahead`; approval "inbox-one-time-dialogs": once
  // the list is taller than the screen, at the next calm moment). `minThreads: 15` is the server's stand-in for "taller
  // than the screen": { id: "list_view", kind: "offer", tenureMs: 2 * DAY_MS, minThreads: 15, ahead: true, enabled: true }.
];

/**
 * Never two dialogs within this long on one machine (the agent note apart): one day (the owner, 2026-11-06, "one day
 * apart"; it was 48 h). One clock for every dialog of the line, the update-day dialogs included.
 */
export const REVEAL_SPACING_MS = DAY_MS;
/** After an offer closed with Not now, the next waits this long: three days (the owner, 2026-11-06; it was four). */
export const REVEAL_NOT_NOW_SPACING_MS = 3 * DAY_MS;
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

/** The spacing holds: a day since the last dialog that stamps the clock, three since an offer's Not now. */
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

/** The offer has been next so long without its moment that it retires. An update-day dialog never retires. */
export function revealRetired(entry: Pick<RevealEntry, "id" | "kind">, state: Pick<RevealState, "waitingSince">, now: Date): boolean {
  if (entry.kind !== "offer") return false;
  const since = time(state.waitingSince?.[entry.id]);
  return since !== null && now.getTime() - since >= REVEAL_RETIRE_MS;
}

/** The entry's "who" holds (the line's rules apart). */
export function revealQualifies(entry: RevealEntry, state: RevealState, now: Date): boolean {
  if (!entry.enabled || !state.release || state.open[entry.id] !== true) return false;
  if (entry.heavyUse && state.heavy !== true) return false;
  if (revealRetired(entry, state, now)) return false;
  const first = time(state.firstUseAt);
  if (first === null) {
    if (entry.kind !== "update") return false;
  } else if (now.getTime() - first < entry.tenureMs) return false;
  if (entry.laterDay && (first === null || revealDay(first) === revealDay(now.getTime()))) return false;
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
    if (entry.aside || !revealQualifies(entry, state, now)) continue;
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

/**
 * The `ahead` offers a page may arm besides `next` (approval "inbox-one-time-dialogs": List view goes at its moment,
 * ahead of the other offers): each one that qualifies, while the line is free and `next` is not an update-day dialog.
 */
export function revealAhead(state: RevealState, now: Date, table: readonly RevealEntry[] = INBOX_REVEALS): RevealId[] {
  const next = revealNext(state, now, table);
  if (next === null && !revealLineFree("spaced", state, now)) return [];
  if (next !== null && table.find((entry) => entry.id === next)?.kind !== "offer") return [];
  return table.filter((entry) => entry.ahead === true && entry.kind === "offer" && entry.id !== next && revealQualifies(entry, state, now)).map((entry) => entry.id);
}

/** The `aside` entries a page may arm on this load (the star ask): each one that may be claimed now. */
export function revealAsideNow(state: RevealState, now: Date, table: readonly RevealEntry[] = INBOX_REVEALS): RevealId[] {
  return table.filter((entry) => entry.aside === true && revealMayClaim(entry.id, state, now, table)).map((entry) => entry.id);
}

/** A claim for `id` may be spent now: it is still next, or an `ahead` offer at its moment. Anything else gets no. */
export function revealMayClaim(id: RevealId, state: RevealState, now: Date, table: readonly RevealEntry[] = INBOX_REVEALS): boolean {
  const entry = table.find((e) => e.id === id);
  if (entry?.aside) return revealQualifies(entry, state, now) && revealLineFree("spaced", state, now);
  return revealNext(state, now, table) === id || revealAhead(state, now, table).includes(id);
}

/** A Not now may be stamped for `id`: an offer of the queue. An update-day dialog's Not now keeps the usual day. */
export function revealNotNowAllowed(id: unknown, table: readonly RevealEntry[] = INBOX_REVEALS): id is RevealId {
  return table.some((entry) => entry.id === id && entry.kind === "offer");
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
  /** The agent note: the agents it was shown for (`revealAgentNoteNew`). */
  agentNote?: { shownFor?: string[] };
}

/** A page's load id, as a page sends it (`X-Plannotator-Load`): 8 to 64 letters, digits, - or _. */
export function revealLoadId(value: string | null | undefined): string | null {
  return typeof value === "string" && /^[A-Za-z0-9_-]{8,64}$/.test(value) ? value : null;
}

/** How many page loads the Inbox remembers (each with the load before it). */
export const REVEAL_LOADS_KEPT = 256;

/**
 * The page loads the Inbox saw, in the order each was first seen: `newest`, and for each load the one first seen just
 * before it. Kept in memory, not in config.json: it changes on every load, and the one-a-day rule already covers the
 * load after a restart. A load counts once: an old tab reading settings again is not a new load.
 */
export interface RevealLoads {
  newest?: string;
  before?: ReadonlyMap<string, string | null>;
}

/** The loads once this page load is seen: null when nothing changes (a load already seen, or no id). */
export function revealSeeLoad(loads: RevealLoads, load: string | null): RevealLoads | null {
  if (!load || loads.before?.has(load)) return null;
  const before = new Map(loads.before ?? []);
  before.set(load, loads.newest ?? null);
  for (const oldest of before.keys()) {
    if (before.size <= REVEAL_LOADS_KEPT) break;
    before.delete(oldest);
  }
  return { newest: load, before };
}

/**
 * This load was first seen right after the load that showed the last dialog (`shownLoad`, saved with the stamp), so it
 * shows none for its whole life. A page that sends no id, or a load this Inbox never saw, is never held back.
 */
export function revealAfterShowLoad(shownLoad: string | undefined, loads: RevealLoads, load: string | null): boolean {
  if (!load || !shownLoad) return false;
  return loads.before?.get(load) === shownLoad;
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

/** The saved line once an offer is closed with Not now: the next waits three days. */
export function revealStampNotNow<T extends RevealsSaved>(saved: T | undefined, at: string): T {
  return { ...(saved ?? ({} as T)), notNowAt: at };
}

/** An agent id as the agent-note claim sends it (`agents`): lower-case letters, digits and -. At most this many. */
export const REVEAL_AGENT_NOTE_MAX_AGENTS = 32;

/**
 * The `agents` of an agent-note claim: the agents the note would ask about. Null when the claim sent none (an older
 * page: the note shows as before); undefined when the value is not a list of agent ids (a validation error).
 */
export function revealAgentNoteAgents(value: unknown): string[] | null | undefined {
  if (value === undefined) return null;
  if (!Array.isArray(value) || value.length === 0 || value.length > REVEAL_AGENT_NOTE_MAX_AGENTS) return undefined;
  if (!value.every((id) => typeof id === "string" && /^[a-z0-9-]{1,40}$/.test(id))) return undefined;
  return [...new Set(value as string[])];
}

/**
 * The agent note is shown once for each agent (approval "inbox-one-time-dialogs": setup, one a day): a claim names an
 * agent it was never shown for, so it may show (and keep the day). A note left unanswered (the tab closed) is not shown
 * again for the same agents, so it never takes another day's place. `agents` null (an older page): it may show.
 */
export function revealAgentNoteNew(shownFor: readonly string[] | undefined, agents: readonly string[] | null): boolean {
  if (agents === null) return true;
  const shown = new Set(shownFor ?? []);
  return agents.some((agent) => !shown.has(agent));
}
