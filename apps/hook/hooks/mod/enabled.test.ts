import { describe, expect, test } from 'bun:test'
import {
  AGENT_TOOL_DEFAULTS,
  INBOX_TOOL_DEFAULTS,
  resolveAgentTool,
  resolveClaudeCodeMod,
  resolveInboxTool,
  resolveSnapshotsEnabled as resolveSharedSnapshots,
  SNAPSHOTS_DEFAULT as SHARED_SNAPSHOTS_DEFAULT,
} from '@plannotator/shared/config'
import {
  AGENT_TOOL_DEFAULT,
  INBOX_TOOL_DEFAULT,
  resolveAgentToolEnabled,
  resolveClaudeModEnabled,
  resolveInboxToolEnabled,
  resolveSnapshotsEnabled,
  SNAPSHOTS_DEFAULT as MOD_SNAPSHOTS_DEFAULT,
} from './enabled'

// The mod cannot import packages/shared, so it mirrors resolveClaudeCodeMod.
// The failure this guards: the two drift, and the CLI docs/settings say the
// mod is off while the mod turns itself on (or the reverse).
describe('on/off knob', () => {
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

  // The owner's decision: on for everyone who has not opted out. A regression
  // here silently returns every user to the blocking flows.
  test('on by default: no setting, an empty or unrecognized env value, an unreadable config file', () => {
    expect(resolveClaudeModEnabled(undefined, null)).toBe(true)
    expect(resolveClaudeModEnabled('', '{}')).toBe(true)
    expect(resolveClaudeModEnabled('garbage', null)).toBe(true)
    expect(resolveClaudeModEnabled(undefined, '{ not json')).toBe(true)
    expect(resolveClaudeCodeMod({}, {})).toBe(true)
  })

  test('the opt-out: an off env value or claudeCodeMod false; the env wins over the file', () => {
    for (const off of ['0', 'false', 'off', 'disabled', ' OFF ']) expect(resolveClaudeModEnabled(off, null)).toBe(false)
    expect(resolveClaudeModEnabled(undefined, '{"claudeCodeMod":false}')).toBe(false)
    expect(resolveClaudeModEnabled(undefined, '{"claudeCodeMod":"0"}')).toBe(false)
    expect(resolveClaudeModEnabled('1', '{"claudeCodeMod":false}')).toBe(true)
    expect(resolveClaudeModEnabled('0', '{"claudeCodeMod":true}')).toBe(false)
  })
})

// Same mirror for the `plannotator` tool switch: the failure is the mod
// registering the tool for a user who turned it off (or the reverse), or the
// owner flipping the default in one place only.
describe('agent tool switch', () => {
  const envs = [undefined, '', '1', 'true', 'ON', ' on ', '0', 'false', 'off', 'disabled', 'yes', 'garbage']
  const configs: unknown[] = [undefined, true, false, 'true', 'false', '1', '0', 'yes', 1, null]

  test('the mod and packages/shared resolve every combination the same way', () => {
    for (const env of envs) {
      for (const value of configs) {
        const config = value === undefined ? {} : { agentTool: value }
        const shared = resolveAgentTool(config as never, env === undefined ? {} : { PLANNOTATOR_AGENT_TOOL: env }, 'claude-code')
        expect([env, value, resolveAgentToolEnabled(env, JSON.stringify(config))]).toEqual([env, value, shared])
      }
    }
    expect(resolveAgentToolEnabled(undefined, '{ not json')).toBe(resolveAgentTool({}, {}, 'claude-code'))
    expect(AGENT_TOOL_DEFAULT).toBe(AGENT_TOOL_DEFAULTS['claude-code'])
  })

  test('agentTool is its own key: it never reads claudeCodeMod, and the mod switch never reads agentTool', () => {
    expect(resolveAgentToolEnabled(undefined, '{"claudeCodeMod":false}')).toBe(AGENT_TOOL_DEFAULT)
    expect(resolveClaudeModEnabled(undefined, '{"agentTool":false}')).toBe(true)
  })
})

// Same mirror for the Inbox connection: the failure is the mod registering the
// plannotator_inbox tool for a user who turned it off (or the reverse).
describe('inbox tool switch', () => {
  const envs = [undefined, '', '1', 'true', 'ON', ' on ', '0', 'false', 'off', 'disabled', 'yes', 'garbage']
  const configs: unknown[] = [
    undefined, true, false, 'true', 'false', '1', '0', 'yes', 1, null,
    // One value per host, as the Inbox's Settings writes it.
    { 'claude-code': false }, { 'claude-code': true, pi: false }, { pi: true }, { 'claude-code': 'false' }, [],
  ]

  test('the mod and packages/shared resolve every combination the same way', () => {
    for (const env of envs) {
      for (const value of configs) {
        const config = value === undefined ? {} : { inboxTool: value }
        const shared = resolveInboxTool(config as never, env === undefined ? {} : { PLANNOTATOR_INBOX_TOOL: env }, 'claude-code')
        expect([env, value, resolveInboxToolEnabled(env, JSON.stringify(config))]).toEqual([env, value, shared])
      }
    }
    expect(resolveInboxToolEnabled(undefined, '{ not json')).toBe(resolveInboxTool({}, {}, 'claude-code'))
    expect(INBOX_TOOL_DEFAULT).toBe(INBOX_TOOL_DEFAULTS['claude-code'])
  })

  test('inboxTool is its own key: agentTool off leaves it on', () => {
    expect(resolveInboxToolEnabled(undefined, '{"agentTool":false}')).toBe(INBOX_TOOL_DEFAULT)
  })
})

// One Snapshots switch for every host: Pi and OpenCode read
// resolveSnapshotsEnabled in packages/shared/config.ts, the mod its mirror.
// The failure: the mod links sessions to the hub for a user who turned
// Snapshots off for Pi and OpenCode (or the reverse), or the default moves in
// one place only.
describe('snapshots switch', () => {
  const envs = [undefined, '', '1', 'true', 'ON', ' on ', '0', 'false', 'off', 'disabled', 'yes', 'garbage']
  const configs: unknown[] = [undefined, true, false, 'true', 'false', '1', '0', 'yes', 1, null]

  test('the mod and packages/shared resolve every combination the same way', () => {
    for (const env of envs) {
      for (const value of configs) {
        const config = value === undefined ? {} : { snapshots: value }
        const shared = resolveSharedSnapshots(config as never, env === undefined ? {} : { PLANNOTATOR_SNAPSHOTS: env })
        expect([env, value, resolveSnapshotsEnabled(env, JSON.stringify(config))]).toEqual([env, value, shared])
      }
    }
    expect(resolveSnapshotsEnabled(undefined, '{ not json')).toBe(resolveSharedSnapshots({}, {}))
    expect(MOD_SNAPSHOTS_DEFAULT).toBe(SHARED_SNAPSHOTS_DEFAULT)
  })

  // The owner's decision: Snapshots ships on for every agent.
  test('on by default; off with PLANNOTATOR_SNAPSHOTS=0 or snapshots false, the env winning', () => {
    expect(resolveSnapshotsEnabled(undefined, null)).toBe(true)
    expect(resolveSharedSnapshots({}, {})).toBe(true)
    expect(resolveSnapshotsEnabled('0', null)).toBe(false)
    expect(resolveSnapshotsEnabled(undefined, '{"snapshots":false}')).toBe(false)
    expect(resolveSnapshotsEnabled('1', '{"snapshots":false}')).toBe(true)
  })
})
