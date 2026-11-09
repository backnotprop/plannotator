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
 *   a plugin's too), no setting, and no plugin beneath the mod made or joined
 *   it (the mod sees only the plugins beneath it);
 * - the person's settings (every source, managed ones included) hold no
 *   ask/deny rule touching Bash, PowerShell, Monitor or rm, no
 *   `blockReadsOutsideWorkingDirectories`, and no PreToolUse or
 *   PermissionRequest hook that could run for Bash;
 * - no enabled plugin's hooks (its `hooks/hooks.json` and the `hooks` of its
 *   `plugin.json`) hold a PreToolUse or PermissionRequest hook that could run
 *   for Bash. The mod answers without the hooks beneath it, so such a hook
 *   would never run.
 *
 * Anything else, or anything it cannot read, steps aside: the prompt shows as
 * it does today. Plannotator never judges a removal itself; it only stops
 * cancelling the person's own setting.
 */

import { isAbsolutePath } from './paths'

/** The variable Claude Code reads for the waiver. */
export const SKIP_RM_PROMPTS_VARIABLE = 'CLAUDE_CODE_EVEN_MORE_DANGEROUSLY_SKIP_PERMISSIONS'

/**
 * Claude Code's removal-check asks (the waiver's `dangerousRemoval`), by the
 * message `tool.check` gives as the verdict's reason.
 */
const REMOVAL_ASK = /^(Dangerous [\w-]+ operation\b|This command passes a shell -c script that runs rm\b)/

/** How long a call's verdict waits for its permission prompt. */
export const REMOVAL_ASK_TTL_MS = 5_000

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
  if (v.decision !== 'ask' || v.rule || v.hook || v.setting || v.plugin) return false
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
  return hooksSelectBash(s.hooks ?? {})
}

/** True when a hooks table (`{ PreToolUse: [...], ... }`) holds a PreToolUse or PermissionRequest hook that could run for Bash, or cannot be read. */
function hooksSelectBash(hooks: unknown): boolean {
  if (!hooks || typeof hooks !== 'object' || Array.isArray(hooks)) return true
  const table = hooks as Record<string, unknown>
  for (const event of ['PreToolUse', 'PermissionRequest']) {
    const entries = table[event]
    if (entries === undefined) continue
    if (!Array.isArray(entries)) return true
    if (entries.some((entry) => !entry || typeof entry !== 'object' || selectsBash((entry as { matcher?: unknown }).matcher))) return true
  }
  return false
}

/** A file's text, or null when it does not exist; rejects when it exists but cannot be read. */
export type ReadText = (path: string) => Promise<string | null>

/** A plugin hooks file's hooks: `{ hooks: { ... } }` (hooks.json) or the table itself (inline in plugin.json). */
function hooksFileSelectsBash(parsed: unknown): boolean {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return true
  const file = parsed as Record<string, unknown>
  return hooksSelectBash(file.hooks !== undefined ? file.hooks : file)
}

/** Whether one installed plugin folder holds a PreToolUse or PermissionRequest hook that could run for Bash, or cannot be read. */
async function pluginFolderSelectsBash(folder: string, readText: ReadText): Promise<boolean> {
  const root = folder.replace(/[\\/]+$/, '')
  const defaultHooks = await readText(`${root}/hooks/hooks.json`)
  if (defaultHooks !== null && hooksFileSelectsBash(JSON.parse(defaultHooks))) return true
  const manifestText = await readText(`${root}/.claude-plugin/plugin.json`)
  if (manifestText === null) return false
  const manifest = JSON.parse(manifestText)
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) return true
  const declared = (manifest as { hooks?: unknown }).hooks
  if (declared === undefined) return false
  for (const item of Array.isArray(declared) ? declared : [declared]) {
    if (typeof item !== 'string') {
      if (hooksFileSelectsBash(item)) return true
      continue
    }
    const named = item.replace(/\$\{CLAUDE_PLUGIN_ROOT\}/g, root)
    const path = isAbsolutePath(named) ? named : `${root}/${named.replace(/^\.[\\/]/, '')}`
    const text = await readText(path)
    // A hooks file the manifest names but that is not there (or that names another variable): the mod cannot tell what it meant.
    if (text === null || hooksFileSelectsBash(JSON.parse(text))) return true
  }
  return false
}

/**
 * True when an enabled plugin (the settings' `enabledPlugins`, found in
 * Claude Code's registry `<config dir>/plugins/installed_plugins.json`) holds a
 * PreToolUse or PermissionRequest hook that could run for Bash, or when any of
 * that cannot be read: the mod steps aside. Plannotator's own hooks are on
 * EnterPlanMode and ExitPlanMode, so they never count.
 */
export async function pluginsGuardRemovals(settings: unknown, configDir: unknown, readText: ReadText): Promise<boolean> {
  try {
    if (!settings || typeof settings !== 'object') return true
    const enabledPlugins = (settings as { enabledPlugins?: unknown }).enabledPlugins
    if (enabledPlugins === undefined) return false
    if (!enabledPlugins || typeof enabledPlugins !== 'object' || Array.isArray(enabledPlugins)) return true
    // `false` turns a plugin off; `true` or a version list turns it on.
    const enabled = Object.entries(enabledPlugins).filter(([, value]) => value !== false).map(([id]) => id)
    if (enabled.length === 0) return false
    if (typeof configDir !== 'string' || !isAbsolutePath(configDir)) return true
    const registryText = await readText(`${configDir.replace(/[\\/]+$/, '')}/plugins/installed_plugins.json`)
    if (registryText === null) return true
    const registry = JSON.parse(registryText)
    if (!registry || typeof registry !== 'object') return true
    const top = registry as { plugins?: unknown } & Record<string, unknown>
    // v2 `{ version, plugins: { id: [records] } }`, or the v1 table `{ id: record }`.
    const table = (top.plugins && typeof top.plugins === 'object' ? top.plugins : top) as Record<string, unknown>
    for (const id of enabled) {
      const value = Object.hasOwn(table, id) ? table[id] : undefined
      const records = Array.isArray(value) ? value : value ? [value] : []
      // Enabled but not in the registry: the mod cannot tell what Claude Code loaded for it.
      if (records.length === 0) return true
      for (const record of records) {
        const installPath = record && typeof record === 'object' ? (record as { installPath?: unknown }).installPath : undefined
        if (typeof installPath !== 'string' || !isAbsolutePath(installPath)) return true
        if (await pluginFolderSelectsBash(installPath, readText)) return true
      }
    }
    return false
  } catch {
    return true
  }
}

/** The key a call's verdict is kept under until its permission prompt: its loop and its command. */
export function removalAskKey(agentId: unknown, input: unknown): string | null {
  const command = input && typeof input === 'object' ? (input as { command?: unknown }).command : undefined
  if (typeof command !== 'string') return null
  return `${typeof agentId === 'string' ? agentId : ''}\u0000${command}`
}

/** The verdicts of recent Bash calls, by `removalAskKey`, until their permission prompt reads them. */
export class RemovalAsks {
  private readonly verdicts = new Map<string, { bare: boolean; at: number }>()

  constructor(
    private readonly now: () => number = () => Date.now(),
    private readonly ttlMs: number = REMOVAL_ASK_TTL_MS,
  ) {}

  /** Keep what `tool.check` decided for a call (the newest wins; at most 64 are kept, each for `ttlMs`). */
  note(key: string | null, verdict: unknown): void {
    if (key === null) return
    this.verdicts.delete(key)
    this.verdicts.set(key, { bare: isBareRemovalAsk(verdict), at: this.now() })
    if (this.verdicts.size > 64) this.verdicts.delete(this.verdicts.keys().next().value as string)
  }

  /** Whether the call's own verdict was a bare removal ask, noted less than `ttlMs` ago; read once. */
  take(key: string | null): boolean {
    if (key === null) return false
    const kept = this.verdicts.get(key)
    this.verdicts.delete(key)
    if (!kept) return false
    const age = this.now() - kept.at
    return kept.bare && age >= 0 && age <= this.ttlMs
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
    /** Claude Code's config folder (`CLAUDE_CONFIG_DIR`, else `~/.claude`), or null. */
    configDir: () => Promise<unknown>
    readText: ReadText
  },
): Promise<{ behavior: 'allow' } | null> {
  // Read first, so a prompt the mod passes on never answers a later call's.
  const bare = asks.take(removalAskKey(event.agent_id, event.tool_input))
  if (!bare || event.permission_mode !== 'bypassPermissions') return null
  try {
    if (!isEnvOn(await read.variable()) || isEnvSet(await read.childSession())) return null
    const settings = await read.settings()
    if (personGuardsRemovals(settings)) return null
    if (await pluginsGuardRemovals(settings, await read.configDir(), read.readText)) return null
  } catch {
    return null
  }
  return { behavior: 'allow' }
}
