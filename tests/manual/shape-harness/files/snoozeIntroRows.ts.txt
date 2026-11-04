/**
 * The window's half of the one-time Snooze announcement's rules (approval "inbox-snooze-announce"): which rows say the
 * person has things to put away. Pure, so a test can move the clock; the page's gate is snoozeIntro.ts, and who gets it
 * at all is the Inbox's (packages/server/inbox-snooze-intro.ts). Inbox-only, so not a core export: the published UI
 * package never needs it.
 */
import type { InboxListRow } from '@plannotator/core/inbox-types';

/** A row "read and left" for this long (the agent's last word is older) counts toward the need. */
export const SNOOZE_INTRO_LEFT_MS = 24 * 60 * 60 * 1000;
/** How many read-and-left rows the list must hold. */
export const SNOOZE_INTRO_LEFT_ROWS = 2;

/** The sections a thread that waits on the person sits in. */
const WAITING_SECTIONS = new Set(['stopped', 'holding', 'waiting']);

/** A thread that still waits on the person: an agent's question or last word is theirs to answer. */
export function snoozeIntroWaits(row: Pick<InboxListRow, 'section' | 'waiting_on_person' | 'snoozed'>): boolean {
  if (row.snoozed) return false;
  return row.waiting_on_person || WAITING_SECTIONS.has(row.section);
}

/**
 * A thread the person read and left: in Stopped, Holding, Waiting or New, nothing unseen (they looked), nothing unsent,
 * not snoozed, and the agent's last word older than `SNOOZE_INTRO_LEFT_MS`.
 */
export function snoozeIntroReadAndLeft(row: Pick<InboxListRow, 'section' | 'unseen' | 'unsent' | 'snoozed' | 'last_agent_at' | 'last_at'>, now: Date): boolean {
  if (row.section !== 'new' && !WAITING_SECTIONS.has(row.section)) return false;
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
