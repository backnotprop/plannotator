import { readReminderSessions, withReminderSession } from './inbox'

export const STORE_INBOX_OFF_SESSIONS = 'inboxOffSessions'

export function readOffSessions(value: unknown): Record<string, number> {
  return readReminderSessions(value)
}

export function withOffSession(record: Record<string, number>, sessionId: string, off: boolean, now: number): Record<string, number> {
  if (off) return withReminderSession(record, sessionId, now)
  const { [sessionId]: _dropped, ...rest } = record
  return rest
}
