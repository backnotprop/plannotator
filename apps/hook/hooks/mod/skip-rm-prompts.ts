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
 *   `blockReadsOutsideWorkingDirectories`, and no PermissionRequest hook that
 *   could run for Bash;
 * - no enabled plugin's hooks (its `hooks/hooks.json` and the `hooks` of its
 *   `plugin.json`) hold a PermissionRequest hook that could run for Bash. The
 *   mod answers without the hooks beneath it, so such a hook would never run.
 *
 * A PreToolUse hook is no reason to step aside by being there: it runs before
 * the permission check, whatever the mod answers later, and Claude Code itself
 * keeps the waiver on beside one. When it asks, that is on the call's verdict
 * (the first condition) and the prompt stays.
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

/**
 * The ask Claude Code words for a command of several parts (`cd /tmp/x && rm
 * -rf logs/*`, `rm -rf a/* ; rm -rf b/*`, a removal outside the working
 * directories beside a `mkdir`): it lists the parts and never says which check
 * asked, so the removal check's ask reads like any other. Group 1: the list.
 */
const PARTS_ASK = /^This Bash command contains multiple operations\. The following parts? requires? approval: ([\s\S]+)$/

/** A listed part that runs `rm` or `rmdir`. */
const REMOVAL_WORD = /(^|[\s;&|({`'"])(rm|rmdir)(\s|$)/

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

/**
 * The parts a several-parts ask lists, when one of them runs `rm` or `rmdir`
 * and no rule, hook, setting or plugin stands on the verdict; else null. Such
 * an ask may be the removal check's alone: `partsAreRemovalAsks` settles it.
 */
export function removalAskParts(verdict: unknown): string[] | null {
  if (!verdict || typeof verdict !== 'object') return null
  const v = verdict as Record<string, unknown>
  if (v.decision !== 'ask' || v.rule || v.hook || v.setting || v.plugin || typeof v.reason !== 'string') return null
  const list = PARTS_ASK.exec(v.reason)?.[1]
  if (!list || !REMOVAL_WORD.test(list)) return null
  const parts = list.split(', ').map((part) => part.trim()).filter(Boolean)
  return parts.length > 0 && parts.length <= 16 ? parts : null
}

/**
 * Why a several-parts ask is not the removal check's alone, for the debug
 * log; null when it is. Claude Code is asked about each listed part by itself
 * (`check`, the mod's `$.tool.check`, which runs nothing): every part must be
 * allowed in this session or be a bare removal-check ask. A part that asks
 * for any other reason, or a check that cannot be made, keeps the prompt. When
 * every part is allowed by itself the ask comes from the parts together, which
 * only the removal check reads that way (a `cd` before a relative removal).
 */
export async function whyPartsAreNotRemovalAsks(parts: readonly string[], check: ((command: string) => Promise<unknown>) | undefined): Promise<string | null> {
  if (!check) return 'the parts of the command could not be checked'
  for (const part of parts) {
    let verdict: unknown
    try {
      verdict = await check(part)
    } catch {
      return 'a part of the command could not be checked'
    }
    const decision = verdict && typeof verdict === 'object' ? (verdict as { decision?: unknown }).decision : undefined
    if (decision === 'allow' || isBareRemovalAsk(verdict)) continue
    return 'a part of the command asks for a reason other than the removal check'
  }
  return null
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

/**
 * Why the person's settings keep the prompt (they guard shell removals
 * themselves, or cannot be read), for the debug log; null when they do not.
 */
export function whyPersonGuardsRemovals(settings: unknown): string | null {
  if (!settings || typeof settings !== 'object') return 'the settings could not be read'
  const s = settings as Record<string, any>
  const permissions = s.permissions ?? {}
  if (typeof permissions !== 'object') return 'the settings\' permissions could not be read'
  if (permissions.blockReadsOutsideWorkingDirectories === true) return 'permissions.blockReadsOutsideWorkingDirectories is on'
  for (const [name, list] of [['ask', permissions.ask], ['deny', permissions.deny]] as const) {
    if (list === undefined) continue
    if (!Array.isArray(list)) return `permissions.${name} could not be read`
    if (list.some((rule) => typeof rule !== 'string' || SHELL_RULE.test(rule) || /\brm\b/.test(rule))) return `a permissions.${name} rule on Bash, PowerShell, Monitor or rm`
  }
  return hooksSelectBash(s.hooks ?? {}) ? 'a PermissionRequest hook in the settings that could run for Bash' : null
}

/** True when the person's settings guard shell removals themselves (or cannot be read): the mod steps aside. */
export function personGuardsRemovals(settings: unknown): boolean {
  return whyPersonGuardsRemovals(settings) !== null
}

/**
 * True when a hooks table (`{ PermissionRequest: [...], ... }`) holds a
 * PermissionRequest hook that could run for Bash, or cannot be read. Those are
 * the hooks the mod's answer would keep from running; a PreToolUse hook has
 * run by then (its ask is on the call's verdict).
 */
function hooksSelectBash(hooks: unknown): boolean {
  if (!hooks || typeof hooks !== 'object' || Array.isArray(hooks)) return true
  const entries = (hooks as Record<string, unknown>).PermissionRequest
  if (entries === undefined) return false
  if (!Array.isArray(entries)) return true
  return entries.some((entry) => !entry || typeof entry !== 'object' || selectsBash((entry as { matcher?: unknown }).matcher))
}

/** A file's text, or null when it does not exist; rejects when it exists but cannot be read. */
export type ReadText = (path: string) => Promise<string | null>

/** A plugin hooks file's hooks: `{ hooks: { ... } }` (hooks.json) or the table itself (inline in plugin.json). */
function hooksFileSelectsBash(parsed: unknown): boolean {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return true
  const file = parsed as Record<string, unknown>
  return hooksSelectBash(file.hooks !== undefined ? file.hooks : file)
}

/** Whether one installed plugin folder holds a PermissionRequest hook that could run for Bash, or cannot be read. */
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
 * Why an enabled plugin keeps the prompt, for the debug log; null when none
 * does. An enabled plugin (the settings' `enabledPlugins`, found in Claude
 * Code's registry `<config dir>/plugins/installed_plugins.json`) keeps it when
 * it holds a PermissionRequest hook that could run for Bash, or when any of
 * that cannot be read. Plannotator's own hooks are on EnterPlanMode and
 * ExitPlanMode, so they never count.
 */
export async function whyPluginsGuardRemovals(settings: unknown, configDir: unknown, readText: ReadText): Promise<string | null> {
  try {
    if (!settings || typeof settings !== 'object') return 'the settings could not be read'
    const enabledPlugins = (settings as { enabledPlugins?: unknown }).enabledPlugins
    if (enabledPlugins === undefined) return null
    if (!enabledPlugins || typeof enabledPlugins !== 'object' || Array.isArray(enabledPlugins)) return 'enabledPlugins could not be read'
    // `false` turns a plugin off; `true` or a version list turns it on.
    const enabled = Object.entries(enabledPlugins).filter(([, value]) => value !== false).map(([id]) => id)
    if (enabled.length === 0) return null
    if (typeof configDir !== 'string' || !isAbsolutePath(configDir)) return "Claude Code's config folder is unknown"
    const registryText = await readText(`${configDir.replace(/[\\/]+$/, '')}/plugins/installed_plugins.json`)
    if (registryText === null) return 'plugins are enabled but the plugin registry (installed_plugins.json) is missing'
    const registry = JSON.parse(registryText)
    if (!registry || typeof registry !== 'object') return 'the plugin registry could not be read'
    const top = registry as { plugins?: unknown } & Record<string, unknown>
    // v2 `{ version, plugins: { id: [records] } }`, or the v1 table `{ id: record }`.
    const table = (top.plugins && typeof top.plugins === 'object' ? top.plugins : top) as Record<string, unknown>
    for (const id of enabled) {
      const value = Object.hasOwn(table, id) ? table[id] : undefined
      const records = Array.isArray(value) ? value : value ? [value] : []
      // Enabled but not in the registry: the mod cannot tell what Claude Code loaded for it.
      if (records.length === 0) return `the enabled plugin ${id} is not in the plugin registry`
      for (const record of records) {
        const installPath = record && typeof record === 'object' ? (record as { installPath?: unknown }).installPath : undefined
        if (typeof installPath !== 'string' || !isAbsolutePath(installPath)) return `the enabled plugin ${id} has no folder in the plugin registry`
        let selects: boolean
        try {
          selects = await pluginFolderSelectsBash(installPath, readText)
        } catch {
          return `the hooks of the enabled plugin ${id} could not be read`
        }
        if (selects) return `the enabled plugin ${id} has a PermissionRequest hook that could run for Bash, or hooks that could not be read`
      }
    }
    return null
  } catch {
    return 'the enabled plugins could not be read'
  }
}

/** True when an enabled plugin keeps the prompt (`whyPluginsGuardRemovals`): the mod steps aside. */
export async function pluginsGuardRemovals(settings: unknown, configDir: unknown, readText: ReadText): Promise<boolean> {
  return (await whyPluginsGuardRemovals(settings, configDir, readText)) !== null
}

/** The key a call's verdict is kept under until its permission prompt: its loop and its command. */
export function removalAskKey(agentId: unknown, input: unknown): string | null {
  const command = input && typeof input === 'object' ? (input as { command?: unknown }).command : undefined
  if (typeof command !== 'string') return null
  return `${typeof agentId === 'string' ? agentId : ''}\u0000${command}`
}

/** The verdicts of recent Bash calls, by `removalAskKey`, until their permission prompt reads them. */
export class RemovalAsks {
  private readonly verdicts = new Map<string, { bare: boolean; parts: string[] | null; at: number }>()

  constructor(
    private readonly now: () => number = () => Date.now(),
    private readonly ttlMs: number = REMOVAL_ASK_TTL_MS,
  ) {}

  /** Keep what `tool.check` decided for a call (the newest wins; at most 64 are kept, each for `ttlMs`). */
  note(key: string | null, verdict: unknown): void {
    if (key === null) return
    this.verdicts.delete(key)
    this.verdicts.set(key, { bare: isBareRemovalAsk(verdict), parts: removalAskParts(verdict), at: this.now() })
    if (this.verdicts.size > 64) this.verdicts.delete(this.verdicts.keys().next().value as string)
  }

  /**
   * The call's own verdict, noted less than `ttlMs` ago; read once. `bare`: a
   * bare removal ask. `parts`: a several-parts ask that may be one
   * (`removalAskParts`).
   */
  read(key: string | null): { bare: boolean; parts: string[] | null } {
    const none = { bare: false, parts: null }
    if (key === null) return none
    const kept = this.verdicts.get(key)
    this.verdicts.delete(key)
    if (!kept) return none
    const age = this.now() - kept.at
    return age >= 0 && age <= this.ttlMs ? { bare: kept.bare, parts: kept.parts } : none
  }

  /** Whether the call's own verdict was a bare removal ask, noted less than `ttlMs` ago; read once. */
  take(key: string | null): boolean {
    return this.read(key).bare
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
    /** Claude Code's own verdict for one command, run by nothing (`$.tool.check`); absent: a several-parts ask keeps its prompt. */
    check?: (command: string) => Promise<unknown>
  },
  /** Told why a prompt is left to the dialog (the debug log's words); never called for an allow. */
  left: (why: string) => void = () => {},
): Promise<{ behavior: 'allow' } | null> {
  // Read first, so a prompt the mod passes on never answers a later call's.
  const { bare, parts } = asks.read(removalAskKey(event.agent_id, event.tool_input))
  const leave = (why: string) => {
    left(why)
    return null
  }
  if (!bare && !parts) return leave('not a removal-check ask alone, or its verdict was not seen in time')
  if (event.permission_mode !== 'bypassPermissions') return leave('not in bypass permissions mode')
  try {
    if (!isEnvOn(await read.variable())) return leave('the variable is off')
    if (isEnvSet(await read.childSession())) return leave('a nested session')
    const settings = await read.settings()
    const person = whyPersonGuardsRemovals(settings)
    if (person) return leave(person)
    const plugins = await whyPluginsGuardRemovals(settings, await read.configDir(), read.readText)
    if (plugins) return leave(plugins)
    if (!bare) {
      const other = await whyPartsAreNotRemovalAsks(parts ?? [], read.check)
      if (other) return leave(other)
    }
  } catch {
    return leave('the settings could not be read')
  }
  return { behavior: 'allow' }
}
