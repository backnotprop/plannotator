/**
 * Whether the mod is switched on. It is OPT-IN: a Claude Code that runs hooks
 * modules loads this plugin's module for everyone, so until the owner makes
 * the non-blocking flows the default the mod stays inert (every hook passes
 * straight through, nothing is registered, no environment is set) unless the
 * user asks for it:
 *
 *   PLANNOTATOR_CLAUDE_MOD=1            (env; wins over the config file)
 *   { "claudeCodeMod": true }           (config.json in the data dir)
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

/** config.json's `claudeCodeMod`, coerced like the CLI's other boolean keys; default false. */
export function parseClaudeModConfig(configText: string | null | undefined): boolean {
  if (!configText) return false
  let value: unknown
  try {
    value = (JSON.parse(configText) as Record<string, unknown> | null)?.claudeCodeMod
  } catch {
    return false
  }
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase()
    if (v === 'true' || v === '1') return true
  }
  return false
}

export function resolveClaudeModEnabled(envValue: string | undefined, configText: string | null | undefined): boolean {
  return parseClaudeModEnv(envValue) ?? parseClaudeModConfig(configText)
}
