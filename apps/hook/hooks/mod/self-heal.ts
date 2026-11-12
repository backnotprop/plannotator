export const MOD_HEAL_EVERY_MS = 30_000

export function disposesOnSessionEnd(
  current: { sessionId: string } | null,
  e: { sessionId?: unknown; agentId?: unknown } | null | undefined,
  processSessionId?: string,
): boolean {
  if (!current) return false
  if (e?.agentId !== undefined && e.agentId !== null && e.agentId !== '') return false
  const ended = e?.sessionId
  if (typeof ended !== 'string' || ended === '') return true
  return ended === current.sessionId || (!!processSessionId && ended === processSessionId)
}

export function healAction(current: { isDisposed: boolean } | null, endedAt: number | null, now: number, everyMs = MOD_HEAL_EVERY_MS): 'rebuild' | 'check' | 'wait' {
  if (current && !current.isDisposed) return 'check'
  if (endedAt !== null && now - endedAt < everyMs) return 'wait'
  return 'rebuild'
}
