import { isAbsolutePath } from './paths'

export const SKIP_RM_PROMPTS_VARIABLE = 'CLAUDE_CODE_EVEN_MORE_DANGEROUSLY_SKIP_PERMISSIONS'

const REMOVAL_ASK = /^(Dangerous [\w-]+ operation\b|This command passes a shell -c script that runs rm\b)/

const PARTS_ASK = /^This Bash command contains multiple operations\. The following parts? requires? approval: ([\s\S]+)$/

const REMOVAL_WORD = /(^|[\s;&|({`'"])(rm|rmdir)(\s|$)/

export const REMOVAL_ASK_TTL_MS = 5_000

const SHELL_RULE = /^\s*(Bash|PowerShell|Monitor)\s*(\(|$)/

export function isEnvOn(value: unknown): boolean {
  return typeof value === 'string' && /^(1|true|yes|on)$/i.test(value.trim())
}

function isEnvSet(value: unknown): boolean {
  return typeof value === 'string' && value.trim() !== '' && !/^(0|false|no|off)$/i.test(value.trim())
}

export function isBareRemovalAsk(verdict: unknown): boolean {
  if (!verdict || typeof verdict !== 'object') return false
  const v = verdict as Record<string, unknown>
  if (v.decision !== 'ask' || v.rule || v.hook || v.setting || v.plugin) return false
  return typeof v.reason === 'string' && REMOVAL_ASK.test(v.reason)
}

export function removalAskParts(verdict: unknown): string[] | null {
  if (!verdict || typeof verdict !== 'object') return null
  const v = verdict as Record<string, unknown>
  if (v.decision !== 'ask' || v.rule || v.hook || v.setting || v.plugin || typeof v.reason !== 'string') return null
  const list = PARTS_ASK.exec(v.reason)?.[1]
  if (!list || !REMOVAL_WORD.test(list)) return null
  const parts = list.split(', ').map((part) => part.trim()).filter(Boolean)
  return parts.length > 0 && parts.length <= 16 ? parts : null
}

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

export function personGuardsRemovals(settings: unknown): boolean {
  return whyPersonGuardsRemovals(settings) !== null
}

function hooksSelectBash(hooks: unknown): boolean {
  if (!hooks || typeof hooks !== 'object' || Array.isArray(hooks)) return true
  const entries = (hooks as Record<string, unknown>).PermissionRequest
  if (entries === undefined) return false
  if (!Array.isArray(entries)) return true
  return entries.some((entry) => !entry || typeof entry !== 'object' || selectsBash((entry as { matcher?: unknown }).matcher))
}

export type ReadText = (path: string) => Promise<string | null>

function hooksFileSelectsBash(parsed: unknown): boolean {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return true
  const file = parsed as Record<string, unknown>
  return hooksSelectBash(file.hooks !== undefined ? file.hooks : file)
}

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
    if (text === null || hooksFileSelectsBash(JSON.parse(text))) return true
  }
  return false
}

export async function whyPluginsGuardRemovals(settings: unknown, configDir: unknown, readText: ReadText): Promise<string | null> {
  try {
    if (!settings || typeof settings !== 'object') return 'the settings could not be read'
    const enabledPlugins = (settings as { enabledPlugins?: unknown }).enabledPlugins
    if (enabledPlugins === undefined) return null
    if (!enabledPlugins || typeof enabledPlugins !== 'object' || Array.isArray(enabledPlugins)) return 'enabledPlugins could not be read'
    const enabled = Object.entries(enabledPlugins).filter(([, value]) => value !== false).map(([id]) => id)
    if (enabled.length === 0) return null
    if (typeof configDir !== 'string' || !isAbsolutePath(configDir)) return "Claude Code's config folder is unknown"
    const registryText = await readText(`${configDir.replace(/[\\/]+$/, '')}/plugins/installed_plugins.json`)
    if (registryText === null) return 'plugins are enabled but the plugin registry (installed_plugins.json) is missing'
    const registry = JSON.parse(registryText)
    if (!registry || typeof registry !== 'object') return 'the plugin registry could not be read'
    const top = registry as { plugins?: unknown } & Record<string, unknown>
    const table = (top.plugins && typeof top.plugins === 'object' ? top.plugins : top) as Record<string, unknown>
    for (const id of enabled) {
      const value = Object.hasOwn(table, id) ? table[id] : undefined
      const records = Array.isArray(value) ? value : value ? [value] : []
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

export async function pluginsGuardRemovals(settings: unknown, configDir: unknown, readText: ReadText): Promise<boolean> {
  return (await whyPluginsGuardRemovals(settings, configDir, readText)) !== null
}

export function removalAskKey(agentId: unknown, input: unknown): string | null {
  const command = input && typeof input === 'object' ? (input as { command?: unknown }).command : undefined
  if (typeof command !== 'string') return null
  return `${typeof agentId === 'string' ? agentId : ''}\u0000${command}`
}

export class RemovalAsks {
  private readonly verdicts = new Map<string, { bare: boolean; parts: string[] | null; at: number }>()

  constructor(
    private readonly now: () => number = () => Date.now(),
    private readonly ttlMs: number = REMOVAL_ASK_TTL_MS,
  ) {}

  note(key: string | null, verdict: unknown): void {
    if (key === null) return
    this.verdicts.delete(key)
    this.verdicts.set(key, { bare: isBareRemovalAsk(verdict), parts: removalAskParts(verdict), at: this.now() })
    if (this.verdicts.size > 64) this.verdicts.delete(this.verdicts.keys().next().value as string)
  }

  read(key: string | null): { bare: boolean; parts: string[] | null } {
    const none = { bare: false, parts: null }
    if (key === null) return none
    const kept = this.verdicts.get(key)
    this.verdicts.delete(key)
    if (!kept) return none
    const age = this.now() - kept.at
    return age >= 0 && age <= this.ttlMs ? { bare: kept.bare, parts: kept.parts } : none
  }

  take(key: string | null): boolean {
    return this.read(key).bare
  }
}

export async function answerRemovalPrompt(
  event: { permission_mode?: unknown; agent_id?: unknown; tool_input?: unknown },
  asks: RemovalAsks,
  read: {
    variable: () => Promise<unknown>
    childSession: () => Promise<unknown>
    settings: () => Promise<unknown>
    configDir: () => Promise<unknown>
    readText: ReadText
    check?: (command: string) => Promise<unknown>
  },
  left: (why: string) => void = () => {},
): Promise<{ behavior: 'allow' } | null> {
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
