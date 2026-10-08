/**
 * Whether the mod is switched on. It is ON BY DEFAULT wherever Claude Code
 * runs hooks modules (register.ts still stands down in `-p` / SDK sessions
 * and where there is no `/bin/sh`). The user turns it off with:
 *
 *   PLANNOTATOR_CLAUDE_MOD=0            (env; also false/off/disabled; wins over the config file)
 *   { "claudeCodeMod": false }          (config.json in the data dir)
 *
 * Off, the mod is inert: every hook passes straight through, nothing is
 * registered, no environment is set, and the classic PermissionRequest hook
 * and `/plannotator-*` skills run exactly as they do without mods.
 *
 * Mirrors `resolveClaudeCodeMod` in packages/shared/config.ts (a hooks module
 * may import only its own files); `enabled.test.ts` keeps the two in step.
 */

/** The env override: true/false, or undefined when it does not decide (unset, empty, unrecognized). */
export function parseClaudeModEnv(value: string | undefined): boolean | undefined {
  const v = value?.trim().toLowerCase()
  if (v === '1' || v === 'true' || v === 'on') return true
  if (v === '0' || v === 'false' || v === 'off' || v === 'disabled') return false
  return undefined
}

/**
 * config.json's `claudeCodeMod`, coerced like the CLI's other boolean keys
 * (`coerceConfigBoolean`): a boolean, or the strings true/1 and false/0.
 * Anything else, a missing key, or an unreadable file is the default: on.
 */
export function parseClaudeModConfig(configText: string | null | undefined): boolean {
  if (!configText) return true
  let value: unknown
  try {
    value = (JSON.parse(configText) as Record<string, unknown> | null)?.claudeCodeMod
  } catch {
    return true
  }
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase()
    if (v === 'true' || v === '1') return true
    if (v === 'false' || v === '0') return false
  }
  return true
}

export function resolveClaudeModEnabled(envValue: string | undefined, configText: string | null | undefined): boolean {
  return parseClaudeModEnv(envValue) ?? parseClaudeModConfig(configText)
}

/**
 * Whether the mod registers Claude's `plannotator` tool when nothing is set.
 * Mirrors the claude-code entry of `AGENT_TOOL_DEFAULTS` in
 * packages/shared/config.ts (enabled.test.ts keeps them equal): on here, where
 * the tool is deferred behind tool search and costs only its name until used.
 */
export const AGENT_TOOL_DEFAULT = true

/**
 * Whether the mod registers the `plannotator` tool (the rest of the mod is
 * unaffected). Off with:
 *
 *   PLANNOTATOR_AGENT_TOOL=0            (env; also false/off/disabled; wins over the config file)
 *   { "agentTool": false }              (config.json in the data dir)
 *
 * Mirrors `resolveAgentTool(config, env, 'claude-code')` in packages/shared/config.ts. Read once, at the
 * first session.start of the Claude Code process: the tool list is part of
 * the prompt, so it never changes under a running session.
 */
export function resolveAgentToolEnabled(envValue: string | undefined, configText: string | null | undefined): boolean {
  const fromEnv = parseClaudeModEnv(envValue)
  if (fromEnv !== undefined) return fromEnv
  if (!configText) return AGENT_TOOL_DEFAULT
  let value: unknown
  try {
    value = (JSON.parse(configText) as Record<string, unknown> | null)?.agentTool
  } catch {
    return AGENT_TOOL_DEFAULT
  }
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase()
    if (v === 'true' || v === '1') return true
    if (v === 'false' || v === '0') return false
  }
  return AGENT_TOOL_DEFAULT
}

/**
 * Plannotator Snapshots (the capture HUD) in the mod: the `/plannotator-snapshot`
 * command and the session's link to the Snapshots hub. OFF until launch, because
 * the plugin ships from main to every mod user; on with:
 *
 *   PLANNOTATOR_SNAPSHOTS=1                 (env; also true/on; 0/false/off/disabled turns it off and wins over the file)
 *   { "snapshots": true }                   (config.json in the data dir)
 *
 * Read once, at the first session.start of the Claude Code process.
 */
export function resolveSnapshotsEnabled(envValue: string | undefined, configText: string | null | undefined): boolean {
  const fromEnv = parseClaudeModEnv(envValue)
  if (fromEnv !== undefined) return fromEnv
  if (!configText) return false
  try {
    const value = (JSON.parse(configText) as Record<string, unknown> | null)?.snapshots
    return value === true || value === 'true' || value === '1'
  } catch {
    return false
  }
}
