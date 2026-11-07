/**
 * Keeps the session's instance alive while the session is. Seen live: an
 * Inbox reply to an idle session never woke it until the person typed; a
 * disposed instance is one way that happens (nothing makes it again until
 * the next turn, tool call or command).
 *
 * `session.end` disposes the instance only when it is for the session that
 * instance serves (`disposesOnSessionEnd`). Defensive: 2.1.318's
 * `session.end` names this session and carries no `agentId`, but an end
 * naming another session or a subagent leaves it polling. And while the mod
 * runs here, a slow timer (`healAction`) rebuilds an instance that is gone or
 * disposed and re-arms an Inbox tick that stopped firing.
 */

/** How often the self-heal looks at the instance. */
export const MOD_HEAL_EVERY_MS = 30_000

/**
 * Whether `session.end` ends the session `current` serves, so it is disposed.
 * Not for a subagent's end (`agentId`) or another session's (`sessionId`
 * names another id). An event with no `sessionId` (an older engine) disposes,
 * as before. `/clear` names the id it leaves, which is the instance's. The
 * end of the session the process is in now (`processSessionId`) disposes too:
 * an instance still serving an older id is stale then.
 */
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

/**
 * What one self-heal look does: `rebuild` a missing or disposed instance,
 * else `check` its tick. A dispose of this session's own `session.end` is
 * left alone for one whole period (`endedAt`): `/clear` moves the session id
 * just after its `session.end`, and a rebuild in between would serve the
 * session being left.
 */
export function healAction(current: { isDisposed: boolean } | null, endedAt: number | null, now: number, everyMs = MOD_HEAL_EVERY_MS): 'rebuild' | 'check' | 'wait' {
  if (current && !current.isDisposed) return 'check'
  if (endedAt !== null && now - endedAt < everyMs) return 'wait'
  return 'rebuild'
}
