/**
 * The line of the Inbox's one-time dialogs (approval "inbox-feature-reveal", 2026-11-03; the schedule, approval
 * "inbox-one-time-dialogs", 2026-11-06, `.product/approved/inbox-one-time-dialogs/`). Pure, so a test can move the
 * clock; the Inbox server (packages/server/inbox.ts) builds the state from config.json and the store, reports
 * `revealNext` to the page (`GET /api/inbox/settings` `reveal.next`, and `reveal.setup` for the agent note) and spends
 * every claim against it.
 *
 * In the line, in this order: Code review's day-0 offer (`CODE_REVIEW_OFFER`), the update-day dialogs (the sound, list
 * options, voice, the tab icon), then the offers (Snooze, the Board, the Checklist). The agent note is a setup dialog: never in the queue, but it keeps the gap
 * (`revealLineFree("setup")`). The tour and the notification ask are not in the line: day 0 is theirs.
 *
 * The rules:
 *  - Day 0 is setup only: every offer needs tenure (two days or more since first use), but Code review's
 *    (`CODE_REVIEW_OFFER`, the owner, 2026-11-06: "show up like immediately"), which takes day 0's one dialog.
 *  - One due at a time: the first entry, in table order, whose "who" holds (a release build, tenure since first use,
 *    enough threads, heavy use where it asks for it, its own conditions).
 *  - Ahead at its moment: an offer marked `ahead` (List view: approval "inbox-one-time-dialogs", "the change") may also
 *    be armed while another offer is next, and goes as soon as its own moment comes, still inside the
 *    spacing rules (`revealAhead`). It never goes before an update-day dialog.
 *  - No one-a-day rule (the owner, 2026-11-09: "I don't wanna wait a whole day now ... at 40 minutes, give him the new
 *    option"): the gap below is the whole pace, so a heavy user may see several dialogs in one day, each at its moment.
 *  - No page-load rule any more (the owner, 2026-11-09: "after 40 minutes, the same tab (or a fresh load) can show the
 *    next one"; it was "never on two page loads in a row", and a load that showed one showed no other): the gap is the
 *    only pace, on any load. `inboxReveals.shownLoad` is still stamped, as a record; nothing reads it.
 *  - Spacing (changed 2026-11-09: about 40 minutes; it was one day): `REVEAL_SPACING_MS` (40 minutes) after the last
 *    dialog of any kind: the line's own (`lastShownAt`), the agent note (`dayShownAt`), the ones that stand aside
 *    (`asideShownAt`: the star ask, the grill-me tip) and the tips outside the line (`tipShownAt`: the Sidebar tip,
 *    the Launch tip), so none stacks on another (`revealGapFree`). The tips keep the gap themselves the same way
 *    (the server asks `revealLineFree("setup")` before it reports or claims one).
 *    `REVEAL_NOT_NOW_SPACING_MS` (3 days) after an offer closed with Not now (`inboxReveals.notNowAt`; offers only, an
 *    update-day dialog's Not now keeps the 40 minutes; the agent note does not wait for it). The clock also
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
export type RevealId = "theme_chooser" | "code_review" | "sound" | "list_intro" | "voice" | "tab_icon" | "snooze" | "bro" | "grill_me_tip" | "board" | "steps" | "star" | "list_view";
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
  /**
   * An `aside` entry that waits for every other card (the grill-me tip; the owner, 2026-11-08: "Sooner: after 3
   * answered questions, whatever the days, once"): claimed only at a moment the line has nothing else for: no card
   * next and still within its patience (one that waited 3 days without its moment is passed, as the line's cards
   * pass it), none ahead, no other `aside` entry still open, and no `aside` entry shown today (`asideShownAt`). Its
   * claim stamps only its own record, so no other dialog's day can move.
   */
  lastResort?: boolean;
  /** Off: never next and never claimed. */
  enabled: boolean;
}

/**
 * Code review's offer (approval "code-review-offer-card", 2026-11-06; the owner: "this one needs to show up like
 * immediately"): its slot in the line. First in the queue with no tenure, so it is next on day 0 (first use not known
 * yet is fine: no tenure to count), and the page opens it at once (`atOnce`, packages/inbox/codeReviewOffer.ts) once
 * the tour's entry screen is gone, before the agent note, which then keeps the gap and waits for a later
 * load. Only while Code review was never decided (config.json `inboxCodeReview` unset). To move the slot, change
 * this entry (its `tenureMs`) or its place in `INBOX_REVEALS`.
 */
export const CODE_REVIEW_OFFER: RevealEntry = { id: "code_review", kind: "offer", tenureMs: 0, minThreads: 0, enabled: true };

/** The queue, in order. */
export const INBOX_REVEALS: readonly RevealEntry[] = [
  // The "themes" dialog (approval "inbox-theme-chooser", 2026-11-10; the owner: "This dialogue should show a little bit
  // earlier and only for users who don't already have a custom theme"): at the front of the line for someone still on
  // the default theme (config.json `inboxThemeChooser`, theme-chooser.ts; anyone on another theme is marked as not
  // needing it). From the second day of use (`laterDay`), so day 0 stays setup's and Code review's offer keeps its
  // "immediately". No thread minimum; it never retires (an update-day dialog) and has no Not now.
  { id: "theme_chooser", kind: "update", tenureMs: 0, minThreads: 0, laterDay: true, enabled: true },
  CODE_REVIEW_OFFER,
  // The update-day dialogs (who: config.json `inboxSound`, `inboxListIntro`, `inboxVoiceIntro`), the line's gap apart
  // (40 minutes): the sound on the update day, then list options and voice, each at its moment.
  { id: "sound", kind: "update", tenureMs: 0, minThreads: 0, enabled: true },
  // "Choose how your list looks" (approval "inbox-rows-dialog"; q-2c590791: "It's when they have more threads, that's
  // the point"): due for everyone, fresh installs too, once the machine holds five threads, with no day count.
  { id: "list_intro", kind: "update", tenureMs: 0, minThreads: 5, enabled: true },
  { id: "voice", kind: "update", tenureMs: 0, minThreads: 0, enabled: true },
  // "Which favicon do you prefer?" (the owner, 2026-11-09: "Ship it as shown"): due for someone who used an earlier
  // Inbox and never chose a favicon (config.json `favicon` unset), decided at the release start; fresh installs never.
  { id: "tab_icon", kind: "update", tenureMs: 0, minThreads: 0, enabled: true },
  // Its own rules stay (packages/server/inbox-snooze-intro.ts); the queue adds the spacing.
  { id: "snooze", kind: "offer", tenureMs: 2 * DAY_MS, minThreads: 0, enabled: true },
  // Bro mode (approval "bro-mode"; its moment, approval "inbox-one-time-dialogs"): only for heavy use (`revealHeavyUse`:
  // 10 or more threads read in 7 days, on 2 or more days), never on day 0 or 1 (2 days' tenure). Opt-in, as the Board:
  // the claim only stamps it, `BroIntro` opens, and only its "Turn it on" writes inboxBro (unset -> true).
  { id: "bro", kind: "offer", tenureMs: 2 * DAY_MS, minThreads: 0, heavyUse: true, enabled: true },
  // The owner: "ok board can be 3 days, snooze 2". Opt-in (the owner, 2026-11-04): the claim only stamps it; the
  // dialog's "Turn it on" writes inboxBoard (unset -> true), "Not now" leaves it unset.
  { id: "board", kind: "offer", tenureMs: 3 * DAY_MS, minThreads: 5, enabled: true },
  // The Checklist (thread steps), approval "inbox-checklist-reveal" (2026-11-04): 5 days ("lands around day 6") and the
  // Board's 5 threads; the Board need not be on. Opt-in, as the Board: the claim only stamps it, `ChecklistIntro` opens,
  // and only its "Turn it on" writes inboxSteps (unset -> true). Until then no word of it reaches an agent.
  { id: "steps", kind: "offer", tenureMs: 5 * DAY_MS, minThreads: 5, enabled: true },
  // The grill-me tip (the owner, 2026-11-08: "if we have any gap in like consistent use, we should say, hey, have you
  // tried /grill-me yet?"; its cadence, the owner: "Sooner: after 3 answered questions, whatever the days, once"). No
  // tenure, but it never costs another card its day (`lastResort`): it waits until the line has nothing else for the
  // moment, and its claim stamps only its own record. Its need is its own (`open`): 3 answered question cards and no
  // sign of grill-me (grill-me-tip.ts `revealGrillMeGap`). Nothing to turn on: `GrillMeTip` says it once.
  { id: "grill_me_tip", kind: "offer", tenureMs: 0, minThreads: 0, aside: true, lastResort: true, enabled: true },
  // The "Star the repo" ask (approval "star-ask", 2026-11-06; packages/shared/star-ask.ts): last in the line, shown
  // from the second day of Inbox use (the owner, 2026-11-06: "Would rather show it on 2nd day of inbox use"; no thread
  // minimum), once across every surface (config.json `starAsk`). Aside from the line's order (the coordinator, for the
  // owner: no offer may lose its showing to it): it takes a calm moment while the line is free, and its claim stamps
  // only its own `inboxReveals.star`, so every other dialog keeps its day. Its claim runs the already-starred check
  // (gh) before it stamps anything; starred already, nothing shows.
  { id: "star", kind: "offer", tenureMs: 0, minThreads: 0, laterDay: true, aside: true, enabled: true },
  // List view's choice (approval "inbox-list-view-dialog"): last in order but ahead at its moment (`ahead`; approval
  // "inbox-one-time-dialogs": once the list is taller than the screen, on Grouped, at the next calm moment; the page
  // checks the screen). `minThreads: 15` is the server's stand-in for "taller than the screen".
  { id: "list_view", kind: "offer", tenureMs: 2 * DAY_MS, minThreads: 15, ahead: true, enabled: true },
];

/**
 * Never two dialogs within this long on one machine: 40 minutes (the owner, 2026-11-09: "the user can wait 20, 40
 * minutes, and at 40 minutes, give him the new option. They don't need to wait a whole day"; it was one day, and at
 * most one a calendar day). One clock for every dialog: the line's, the agent note and the ones that stand aside.
 */
export const REVEAL_SPACING_MS = 40 * 60 * 1000;
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
  /** The last dialog of any kind in the line, the agent note included (config.json `inboxReveals.dayShownAt`; the name is from the one-a-day rule it once kept). */
  dayShownAt?: string | null;
  /** The last offer closed with Not now (config.json `inboxReveals.notNowAt`). */
  notNowAt?: string | null;
  /** Heavy use holds (`revealHeavyUse`). Absent: false. */
  heavy?: boolean;
  /** Threads on this machine. */
  threads: number;
  /** Per entry: its own conditions hold (not shown yet; its feature never decided by the person). Absent: false. */
  open: Partial<Record<RevealId, boolean>>;
  /** Per entry: when it first became next (config.json `inboxReveals.waitingSince`). Patience counts from it. */
  waitingSince?: Partial<Record<RevealId, string>>;
  /**
   * When a tip outside the line was last shown (config.json `inboxReveals.sidebar_tip.shownAt`, `launch_tip.shownAt`):
   * the gap counts from it too, so no dialog follows a tip within 40 minutes, and a tip waits out the gap after a dialog.
   */
  tipShownAt?: string | null;
  /** When an `aside` entry was last shown (config.json `inboxReveals.star.shownAt`, `grill_me_tip.shownAt`): the gap counts from it too, and a `lastResort` entry never goes on its day. */
  asideShownAt?: string | null;
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

/** The spacing holds: `REVEAL_SPACING_MS` since the last dialog that stamps the clock, three days since an offer's Not now. */
export function revealSpaced(lastShownAt: string | null | undefined, now: Date, notNowAt?: string | null): boolean {
  const last = time(lastShownAt);
  if (last !== null && now.getTime() - last < REVEAL_SPACING_MS) return false;
  const notNow = time(notNowAt);
  return notNow === null || now.getTime() - notNow >= REVEAL_NOT_NOW_SPACING_MS;
}

/**
 * No dialog of any kind was shown within `REVEAL_SPACING_MS`: the line's own, the agent note, the ones that stand
 * aside. (Until 2026-11-09 this was "none today", a local calendar day.)
 */
export function revealGapFree(state: Pick<RevealState, "lastShownAt" | "dayShownAt" | "asideShownAt" | "tipShownAt">, now: Date): boolean {
  return [state.lastShownAt, state.dayShownAt, state.asideShownAt, state.tipShownAt].every((stamp) => {
    const at = time(stamp);
    return at === null || now.getTime() - at >= REVEAL_SPACING_MS;
  });
}

/**
 * The line's own rules, for any dialog in it, on any page load: not within the gap of any other dialog, and (except
 * the agent note, `setup`) not within three days of an offer's Not now. A dev build keeps no line: free.
 */
export function revealLineFree(kind: "setup" | "spaced", state: RevealState, now: Date): boolean {
  if (!state.release) return true;
  if (!revealGapFree(state, now)) return false;
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
    // First use not known yet (a fresh install, nothing in the store): only what needs no tenure (an update-day
    // dialog, Code review's day-0 offer).
    if (entry.kind !== "update" && entry.tenureMs > 0) return false;
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
  if (entry?.aside) {
    if (!revealQualifies(entry, state, now) || !revealLineFree("spaced", state, now)) return false;
    if (!entry.lastResort) return true;
    const asideToday = time(state.asideShownAt);
    return (
      (asideToday === null || revealDay(asideToday) !== revealDay(now.getTime())) &&
      !table.some((other) => other.aside && other.id !== entry.id && other.enabled && state.open[other.id] === true) &&
      !revealFresh(state, now, table) &&
      revealAhead(state, now, table).length === 0
    );
  }
  return revealNext(state, now, table) === id || revealAhead(state, now, table).includes(id);
}

/**
 * Some card of the line is next and still within its patience: due, its moment still awaited. A card that has waited
 * out its patience (3 days without its moment) is passed by the line's other cards, and by a `lastResort` one.
 */
function revealFresh(state: RevealState, now: Date, table: readonly RevealEntry[]): boolean {
  if (!revealLineFree("spaced", state, now)) return false;
  return table.some((entry) => {
    if (entry.aside || !revealQualifies(entry, state, now)) return false;
    const since = time(state.waitingSince?.[entry.id]);
    return since === null || now.getTime() - since < REVEAL_PATIENCE_MS;
  });
}

/**
 * The next moment the line can change by time alone, or null when no date ahead can change it: the end of the gap
 * after each dialog, the end of the three days after a Not now, and for each entry still open the end of its tenure, of
 * its patience and (an offer) of its 14 days, and the day after first use for an entry that waits for a later day.
 * The Inbox reports how far away it is (`reveal.again_in`), so a page left loaded asks again once, then, with one
 * timer and no polling (packages/inbox/reveal.ts `useLineLatch`). Everything else that moves the line (a thread
 * arriving, a switch, a claim) is an event, not a date.
 */
export function revealAgainAt(state: RevealState, now: Date, table: readonly RevealEntry[] = INBOX_REVEALS): number | null {
  if (!state.release) return null;
  const moments: (number | null)[] = [];
  const after = (stamp: string | null | undefined, ms: number) => {
    const at = time(stamp);
    moments.push(at === null ? null : at + ms);
  };
  for (const stamp of [state.lastShownAt, state.dayShownAt, state.asideShownAt, state.tipShownAt]) after(stamp, REVEAL_SPACING_MS);
  after(state.notNowAt, REVEAL_NOT_NOW_SPACING_MS);
  const first = time(state.firstUseAt);
  for (const entry of table) {
    if (!entry.enabled || state.open[entry.id] !== true) continue;
    if (first !== null) {
      moments.push(first + entry.tenureMs);
      if (entry.laterDay) {
        const day = new Date(first);
        moments.push(new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1).getTime());
      }
    }
    after(state.waitingSince?.[entry.id], REVEAL_PATIENCE_MS);
    if (entry.kind === "offer") after(state.waitingSince?.[entry.id], REVEAL_RETIRE_MS);
  }
  const ahead = moments.filter((at): at is number => at !== null && at > now.getTime());
  return ahead.length === 0 ? null : Math.min(...ahead);
}

/** A Not now may be stamped for `id`: an offer of the queue. An update-day dialog's Not now keeps the usual day. */
export function revealNotNowAllowed(id: unknown, table: readonly RevealEntry[] = INBOX_REVEALS): id is RevealId {
  return table.some((entry) => entry.id === id && entry.kind === "offer" && !entry.lastResort);
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
  /** The load id of the page that showed the last dialog: a record only (the page-load rule ended 2026-11-09). */
  shownLoad?: string;
  waitingSince?: Partial<Record<RevealId, string>>;
  /** The agent note: the agents it was shown for (`revealAgentNoteNew`). */
  agentNote?: { shownFor?: string[] };
}

/** A page's load id, as a page sends it (`X-Plannotator-Load`): 8 to 64 letters, digits, - or _. */
export function revealLoadId(value: string | null | undefined): string | null {
  return typeof value === "string" && /^[A-Za-z0-9_-]{8,64}$/.test(value) ? value : null;
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
 * The agent note is shown once for each agent (approval "inbox-one-time-dialogs": setup): a claim names an
 * agent it was never shown for, so it may show (and start the gap). A note left unanswered (the tab closed) is not shown
 * again for the same agents, so it never takes another day's place. `agents` null (an older page): it may show.
 */
export function revealAgentNoteNew(shownFor: readonly string[] | undefined, agents: readonly string[] | null): boolean {
  if (agents === null) return true;
  const shown = new Set(shownFor ?? []);
  return agents.some((agent) => !shown.has(agent));
}
