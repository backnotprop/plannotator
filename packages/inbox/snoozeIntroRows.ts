import type { InboxListRow } from '@plannotator/core/inbox-types';

export const SNOOZE_INTRO_LEFT_MS = 24 * 60 * 60 * 1000;
export const SNOOZE_INTRO_LEFT_ROWS = 2;

const WAITING_SECTIONS = new Set(['stopped', 'holding', 'waiting']);

export function snoozeIntroWaits(row: Pick<InboxListRow, 'section' | 'waiting_on_person' | 'snoozed'>): boolean {
  if (row.snoozed) return false;
  return row.waiting_on_person || WAITING_SECTIONS.has(row.section);
}

export function snoozeIntroReadAndLeft(row: Pick<InboxListRow, 'section' | 'unseen' | 'unsent' | 'snoozed' | 'last_agent_at' | 'last_at'>, now: Date): boolean {
  if (row.section !== 'new' && !WAITING_SECTIONS.has(row.section)) return false;
  if (row.unseen !== 0 || row.unsent || row.snoozed) return false;
  const last = Date.parse(row.last_agent_at ?? row.last_at);
  return !Number.isNaN(last) && now.getTime() - last >= SNOOZE_INTRO_LEFT_MS;
}

export function snoozeIntroNeed(rows: Iterable<Parameters<typeof snoozeIntroReadAndLeft>[0]>, now: Date): boolean {
  let count = 0;
  for (const row of rows) if (snoozeIntroReadAndLeft(row, now) && ++count >= SNOOZE_INTRO_LEFT_ROWS) return true;
  return false;
}
