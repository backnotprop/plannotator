/**
 * The one-time Snooze announcement (approval "inbox-snooze-announce", 2026-11-02): who gets it and which rows say the
 * person has things to put away. Pure, so the Inbox (packages/server/inbox.ts) and the window
 * (packages/inbox/snoozeIntro.ts) read the same rules, and so a test can move the clock.
 *
 * Who (the server, config.json `inboxSnoozeIntro`): a release build, first use at least two days ago (rebuilt once
 * from the event log on upgrade), never snoozed anything (a mark of its own: snoozes.json deletes itself with the last
 * snooze), and not shown yet. There is no active-days rule (the owner, 2026-11-02). It shows on this computer and on
 * the owner's phone, never to a tailnet guest (the owner, q-e29f8cd6).
 *
 * When (the window): right after the person leaves a thread that still waits on them without answering it, with two or
 * more threads read and left for a day or more. The page's own thresholds are in packages/inbox/snoozeIntro.ts.
 */
import type { InboxListRow } from "./inbox-types";

/** First use must be at least this long ago: two days (the owner: "I think this needs to be 2 days"). */
export const SNOOZE_INTRO_TENURE_MS = 2 * 24 * 60 * 60 * 1000;

/** A row "read and left" for this long (the agent's last word is older) counts toward the need. */
export const SNOOZE_INTRO_LEFT_MS = 24 * 60 * 60 * 1000;
/** How many read-and-left rows the list must hold. */
export const SNOOZE_INTRO_LEFT_ROWS = 2;

/** What config.json keeps (`inboxSnoozeIntro`). Every field is an ISO time. */
export interface SnoozeIntroSaved {
  /** The person's first use of the Inbox: the oldest record in the event log. */
  firstUseAt?: string;
  /** The person snoozed something (any route: the window, the phone, a linked machine's forward). Never again then. */
  snoozedAt?: string;
  /** A page claimed the dialog. Never again. */
  shownAt?: string;
}

/**
 * Whether the Inbox has the dialog due: a release build, first use at least `SNOOZE_INTRO_TENURE_MS` ago, never
 * snoozed, never shown. A first use in the future (a clock that moved back) is not tenure.
 */
export function snoozeIntroDue(saved: SnoozeIntroSaved | undefined, now: Date, release: boolean): boolean {
  if (!release || !saved || saved.snoozedAt || saved.shownAt) return false;
  const first = saved.firstUseAt ? Date.parse(saved.firstUseAt) : Number.NaN;
  if (Number.isNaN(first)) return false;
  return now.getTime() - first >= SNOOZE_INTRO_TENURE_MS;
}

/**
 * The person's first use, rebuilt from the event log: the oldest time any line or record carries (a line's `at`, a
 * record's `created_at`). Null for an empty log.
 */
export function snoozeIntroFirstUse(lines: Iterable<{ at: string; record?: unknown }>): string | null {
  let oldest = Number.POSITIVE_INFINITY;
  for (const line of lines) {
    const at = Date.parse(line.at);
    if (!Number.isNaN(at) && at < oldest) oldest = at;
    const created = (line.record as { created_at?: unknown } | null | undefined)?.created_at;
    const made = typeof created === "string" ? Date.parse(created) : Number.NaN;
    if (!Number.isNaN(made) && made < oldest) oldest = made;
  }
  return Number.isFinite(oldest) ? new Date(oldest).toISOString() : null;
}

/** The sections a thread that waits on the person sits in. */
const WAITING_SECTIONS = new Set(["stopped", "holding", "waiting"]);

/** A thread that still waits on the person: an agent's question or last word is theirs to answer. */
export function snoozeIntroWaits(row: Pick<InboxListRow, "section" | "waiting_on_person" | "snoozed">): boolean {
  if (row.snoozed) return false;
  return row.waiting_on_person || WAITING_SECTIONS.has(row.section);
}

/**
 * A thread the person read and left: in Stopped, Holding, Waiting or New, nothing unseen (they looked), nothing unsent,
 * not snoozed, and the agent's last word older than `SNOOZE_INTRO_LEFT_MS`.
 */
export function snoozeIntroReadAndLeft(row: Pick<InboxListRow, "section" | "unseen" | "unsent" | "snoozed" | "last_agent_at" | "last_at">, now: Date): boolean {
  if (row.section !== "new" && !WAITING_SECTIONS.has(row.section)) return false;
  if (row.unseen !== 0 || row.unsent || row.snoozed) return false;
  const last = Date.parse(row.last_agent_at ?? row.last_at);
  return !Number.isNaN(last) && now.getTime() - last >= SNOOZE_INTRO_LEFT_MS;
}

/** Whether the list holds enough read-and-left rows. */
export function snoozeIntroNeed(rows: Iterable<Parameters<typeof snoozeIntroReadAndLeft>[0]>, now: Date): boolean {
  let count = 0;
  for (const row of rows) if (snoozeIntroReadAndLeft(row, now) && ++count >= SNOOZE_INTRO_LEFT_ROWS) return true;
  return false;
}
