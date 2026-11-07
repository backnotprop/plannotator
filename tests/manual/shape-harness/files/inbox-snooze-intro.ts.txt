/**
 * The one-time Snooze announcement (approval "inbox-snooze-announce", 2026-11-02): who gets it. Pure, so a test can
 * move the clock; packages/server/inbox.ts reads and stamps config.json with it. The window's side (which rows say the
 * person has things to put away, and when) is packages/inbox/snoozeIntro.ts. Inbox-only, so neither half is a core
 * export: the published UI package never needs them.
 *
 * Who (config.json `inboxSnoozeIntro`): a release build, first use at least two days ago (rebuilt once from the event
 * log on upgrade), never snoozed anything (a mark of its own: snoozes.json deletes itself with the last snooze), and
 * not shown yet. There is no active-days rule (the owner, 2026-11-02). It shows on this computer and on the owner's
 * phone, never to a tailnet guest (the owner, q-e29f8cd6).
 */

/** First use must be at least this long ago: two days (the owner: "I think this needs to be 2 days"). */
export const SNOOZE_INTRO_TENURE_MS = 2 * 24 * 60 * 60 * 1000;

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
 * snoozed, never shown.
 */
export function snoozeIntroDue(saved: SnoozeIntroSaved | undefined, now: Date, release: boolean): boolean {
  if (!release || !saved?.firstUseAt || saved.snoozedAt || saved.shownAt) return false;
  return now.getTime() - Date.parse(saved.firstUseAt) >= SNOOZE_INTRO_TENURE_MS;
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
