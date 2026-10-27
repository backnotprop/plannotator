// The customizable Inbox reminder in the Claude Code mod (#2194). The mod
// cannot import packages/shared, so it reads config.json `prompts.inbox` with
// its own copy (enabled.ts over the contract's inboxReminderCustomText); the
// failure this guards: the copy drifts, or a config.json without
// `prompts.inbox` changes a single byte of what Claude reads in the
// `prompt.context` block, the prompt.submit copy, or the post-compaction line.
import { describe, expect, test } from 'bun:test'
import { resolveInboxReminderText } from '@plannotator/shared/config'
import { INBOX_REMINDER_MAX_CHARS } from '@plannotator/shared/inbox/connection'
import { resolveInboxReminderCustom } from './enabled'
import { INBOX_REMINDER_BLOCK, inboxReminderEnvValue, withInboxReminder } from './inbox'
import { inboxReminderFor, inboxReminderText } from './inbox-contract'

const TOOL = 'mcp__plugin_plannotator_tools__plannotator_inbox'
/** The built-in block, with the engine's tool name. */
const MAIN_BLOCK = inboxReminderText(TOOL)

const UNSET_TEXTS: Array<string | null | undefined> = [
  undefined,
  null,
  '',
  '{ not json',
  '{}',
  '{"inboxReminder":true}',
  '{"prompts":{"review":{"denied":"Check."},"plan":{"runtimes":{"claude-code":{"approved":"ok"}}}}}',
  '{"prompts":{"inbox":{}}}',
  '{"prompts":{"inbox":{"reminder":"  "}}}',
  JSON.stringify({ prompts: { inbox: { reminder: 'z'.repeat(INBOX_REMINDER_MAX_CHARS + 1) } } }),
  '{"prompts":{"inbox":{"runtimes":{"pi":{"reminder":"Pi only."}}}}}',
  '{"prompts":"nope"}',
]

describe('no prompts.inbox: the mod sends today\'s bytes', () => {
  for (const [index, text] of UNSET_TEXTS.entries()) {
    test(`config.json #${index}`, () => {
      const custom = resolveInboxReminderCustom(text)
      expect(custom).toBeNull()
      // prompt.context: the block.
      expect(withInboxReminder([], TOOL, custom)).toEqual([{ name: INBOX_REMINDER_BLOCK, text: MAIN_BLOCK }])
      expect(withInboxReminder([], TOOL, custom)).toEqual(withInboxReminder([], TOOL))
      // The prompt.submit copy and the post-compaction variable.
      expect(inboxReminderFor(custom, TOOL)).toBe(inboxReminderText(TOOL))
      expect(inboxReminderEnvValue(true, TOOL, custom)).toBe(MAIN_BLOCK)
      expect(inboxReminderEnvValue(true, TOOL, custom)).toBe(inboxReminderEnvValue(true, TOOL))
    })
  }
})

describe('the mod and packages/shared resolve prompts.inbox the same way', () => {
  const shared: unknown[] = [undefined, '', ' ', 'Shared.', 'Use plannotator_inbox send_message.', 'x'.repeat(INBOX_REMINDER_MAX_CHARS), 'x'.repeat(INBOX_REMINDER_MAX_CHARS + 1), 7, null]
  const own: unknown[] = [undefined, '', 'Claude only: plannotator_inbox.', 'y'.repeat(INBOX_REMINDER_MAX_CHARS + 1), false]
  const others: unknown[] = [undefined, { pi: { reminder: 'Pi.' } }, { opencode: { reminder: 'OC.' } }]

  test('every combination', () => {
    for (const s of shared) {
      for (const o of own) {
        for (const other of others) {
          const inbox: Record<string, unknown> = {}
          if (s !== undefined) inbox.reminder = s
          const runtimes: Record<string, unknown> = { ...(other as object) }
          if (o !== undefined) runtimes['claude-code'] = { reminder: o }
          if (Object.keys(runtimes).length > 0) inbox.runtimes = runtimes
          const config = { prompts: { inbox } }
          const mod = inboxReminderFor(resolveInboxReminderCustom(JSON.stringify(config)), TOOL)
          expect([s, o, other, mod]).toEqual([s, o, other, resolveInboxReminderText(config as never, 'claude-code', { toolName: TOOL })])
        }
      }
    }
  })

  test('a custom text replaces the block and names the registered tool', () => {
    const custom = resolveInboxReminderCustom(JSON.stringify({ prompts: { inbox: { reminder: 'Shared.', runtimes: { 'claude-code': { reminder: 'Ask upstream, then plannotator_inbox.' } } } } }))
    expect(withInboxReminder([{ name: 'other', text: 'x' }], TOOL, custom)).toEqual([
      { name: 'other', text: 'x' },
      { name: INBOX_REMINDER_BLOCK, text: `Ask upstream, then ${TOOL}.` },
    ])
    // The compact hook prints it with printf, so any text is published as it is.
    expect(inboxReminderEnvValue(true, TOOL, 'a\\nb')).toBe('a\\nb')
  })
})
