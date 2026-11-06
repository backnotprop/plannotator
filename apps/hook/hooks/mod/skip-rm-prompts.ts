/**
 * CLAUDE_CODE_EVEN_MORE_DANGEROUSLY_SKIP_PERMISSIONS, kept working beside
 * Plannotator's plan hook.
 *
 * In bypass permissions mode the variable waives the prompts Claude Code raises
 * for removals it cannot prove safe (`rm -rf logs/*`), but only while no
 * PermissionRequest hook is installed: any one, Plannotator's ExitPlanMode
 * hook included, turns it off for the whole session. So the mod answers those
 * prompts itself, with allow, where the variable would have waived them, and
 * only there:
 *
 * - the variable is set and this is not a nested (child) session;
 * - the call's loop is in bypass permissions mode (a subagent's own mode);
 * - the call's verdict, seen by the mod's `tool.check` hook, is an ask from
 *   the removal check alone: no permission rule, no PreToolUse hook (anyone's,
 *   a plugin's too), no setting and no other plugin made or joined it;
 * - the person's settings (every source, managed ones included) hold no
 *   ask/deny rule touching Bash, PowerShell, Monitor or rm, no
 *   `blockReadsOutsideWorkingDirectories`, and no PreToolUse or
 *   PermissionRequest hook that could run for Bash.
 *
 * Anything else, or anything it cannot read, steps aside: the prompt shows as
 * it does today. Plannotator never judges a removal itself; it only stops
 * cancelling the person's own setting.
 */

/** Claude Code's removal-check asks, as `tool.check` words them (the waiver's `dangerousRemoval`). */
const REMOVAL_ASK = /^(Dangerous [\w-]+ operation\b|This shell -c script runs rm\b)/

/** The tools whose ask/deny rules turn the waiver off in Claude Code itself. */
const SHELL_RULE = /^\s*(Bash|PowerShell|Monitor)\s*(\(|$)/

/** True for the env values Claude Code reads as on. */
export function isEnvOn(value: unknown): boolean {
  return typeof value === 'string' && /^(1|true|yes|on)$/i.test(value.trim())
}

/** True for any value but unset, empty or an explicit off: the cautious reading. */
function isEnvSet(value: unknown): boolean {
  return typeof value === 'string' && value.trim() !== '' && !/^(0|false|no|off)$/i.test(value.trim())
}

/** A real call's verdict the mod may answer: a bare removal-check ask. */
export function isBareRemovalAsk(verdict: unknown): boolean {
  if (!verdict || typeof verdict !== 'object') return false
  const v = verdict as Record<string, unknown>
  if (v.decision !== 'ask' || v.rule || v.hook || v.setting || v.plugin || v.ceiling) return false
  return typeof v.reason === 'string' && REMOVAL_ASK.test(v.reason)
}

/** Whether a hook matcher could select Bash (absent, `*`, a regex that matches, or one that will not compile). */
function selectsBash(matcher: unknown): boolean {
  if (matcher === undefined || matcher === null || matcher === '' || matcher === '*') return true
  if (typeof matcher !== 'string') return true
  if (matcher.includes('Bash')) return true
  try {
    return new RegExp(matcher).test('Bash')
  } catch {
    return true
  }
}

/** True when the person's settings guard shell removals themselves (or cannot be read): the mod steps aside. */
export function personGuardsRemovals(settings: unknown): boolean {
  if (!settings || typeof settings !== 'object') return true
  const s = settings as Record<string, any>
  const permissions = s.permissions ?? {}
  if (typeof permissions !== 'object') return true
  if (permissions.blockReadsOutsideWorkingDirectories === true) return true
  for (const list of [permissions.ask, permissions.deny]) {
    if (list === undefined) continue
    if (!Array.isArray(list)) return true
    if (list.some((rule) => typeof rule !== 'string' || SHELL_RULE.test(rule) || /\brm\b/.test(rule))) return true
  }
  const hooks = s.hooks ?? {}
  if (typeof hooks !== 'object') return true
  for (const event of ['PreToolUse', 'PermissionRequest']) {
    const entries = hooks[event]
    if (entries === undefined) continue
    if (!Array.isArray(entries)) return true
    if (entries.some((entry) => !entry || typeof entry !== 'object' || selectsBash(entry.matcher))) return true
  }
  return false
}

/** The key a call's verdict is kept under until its permission prompt: its loop and its command. */
export function removalAskKey(agentId: unknown, input: unknown): string | null {
  const command = input && typeof input === 'object' ? (input as { command?: unknown }).command : undefined
  if (typeof command !== 'string') return null
  return `${typeof agentId === 'string' ? agentId : ''}\u0000${command}`
}

/** The verdicts of recent Bash calls, by `removalAskKey`, until their permission prompt reads them. */
export class RemovalAsks {
  private readonly verdicts = new Map<string, boolean>()

  /** Keep what `tool.check` decided for a call (the newest wins; at most 64 are kept). */
  note(key: string | null, verdict: unknown): void {
    if (key === null) return
    this.verdicts.delete(key)
    this.verdicts.set(key, isBareRemovalAsk(verdict))
    if (this.verdicts.size > 64) this.verdicts.delete(this.verdicts.keys().next().value as string)
  }

  /** Whether the call's own verdict was a bare removal ask; read once. */
  take(key: string | null): boolean {
    if (key === null) return false
    const bare = this.verdicts.get(key) === true
    this.verdicts.delete(key)
    return bare
  }
}

/**
 * The answer to a Bash permission prompt: `allow` where the variable would have
 * waived it, else null (the hooks beneath and the dialog decide).
 */
export async function answerRemovalPrompt(
  event: { permission_mode?: unknown; agent_id?: unknown; tool_input?: unknown },
  asks: RemovalAsks,
  read: {
    variable: () => Promise<unknown>
    childSession: () => Promise<unknown>
    settings: () => Promise<unknown>
  },
): Promise<{ behavior: 'allow' } | null> {
  // Read first, so a prompt the mod passes on never answers a later call's.
  const bare = asks.take(removalAskKey(event.agent_id, event.tool_input))
  if (!bare || event.permission_mode !== 'bypassPermissions') return null
  try {
    if (!isEnvOn(await read.variable()) || isEnvSet(await read.childSession())) return null
    if (personGuardsRemovals(await read.settings())) return null
  } catch {
    return null
  }
  return { behavior: 'allow' }
}
