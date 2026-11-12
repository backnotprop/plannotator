import { describe, expect, test } from 'bun:test'
import { resolveInboxReminderText } from '@plannotator/shared/config'
import { INBOX_REMINDER_MAX_CHARS } from '@plannotator/shared/inbox/connection'
import { resolveInboxReminderCustom } from './enabled'
import { inboxReminderEnvValue } from './inbox'
import { inboxReminderFor, inboxReminderText } from './inbox-contract'

const TOOL = 'mcp__plugin_plannotator_tools__plannotator_inbox'
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
      expect(inboxReminderFor(custom, TOOL)).toBe(inboxReminderText(TOOL))
      expect(inboxReminderFor(custom, TOOL)).toBe(MAIN_BLOCK)
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

  test('a custom text replaces the line and names the registered tool', () => {
    const custom = resolveInboxReminderCustom(JSON.stringify({ prompts: { inbox: { reminder: 'Shared.', runtimes: { 'claude-code': { reminder: 'Ask upstream, then plannotator_inbox.' } } } } }))
    expect(inboxReminderFor(custom, TOOL)).toBe(`Ask upstream, then ${TOOL}.`)
    expect(inboxReminderEnvValue(true, TOOL, 'a\\nb')).toBe('a\\nb')
  })
})
