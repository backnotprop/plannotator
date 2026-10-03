import { describe, expect, test } from 'bun:test'
import { resolveClaudeCodeMod } from '@plannotator/shared/config'
import { resolveClaudeModEnabled } from './enabled'

// The mod cannot import packages/shared, so it mirrors resolveClaudeCodeMod.
// The failure this guards: the two drift, and the CLI docs/settings say the
// mod is off while the mod turns itself on (or the reverse).
describe('opt-in knob', () => {
  const envs = [undefined, '', '1', 'true', 'ON', ' on ', '0', 'false', 'off', 'disabled', 'yes', 'garbage']
  const configs: unknown[] = [undefined, true, false, 'true', 'false', '1', '0', 'yes', 1, null]

  test('the mod and packages/shared resolve every combination the same way', () => {
    for (const env of envs) {
      for (const value of configs) {
        const config = value === undefined ? {} : { claudeCodeMod: value }
        const shared = resolveClaudeCodeMod(config as never, env === undefined ? {} : { PLANNOTATOR_CLAUDE_MOD: env })
        expect([env, value, resolveClaudeModEnabled(env, JSON.stringify(config))]).toEqual([env, value, shared])
      }
    }
  })

  test('off by default, including an unreadable config file', () => {
    expect(resolveClaudeModEnabled(undefined, null)).toBe(false)
    expect(resolveClaudeModEnabled(undefined, '{ not json')).toBe(false)
    expect(resolveClaudeModEnabled('0', '{"claudeCodeMod":true}')).toBe(false)
    expect(resolveClaudeModEnabled('1', null)).toBe(true)
  })
})
