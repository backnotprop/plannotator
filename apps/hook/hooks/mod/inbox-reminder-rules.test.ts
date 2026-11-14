import { describe, expect, test } from 'bun:test'
import { resolveInboxReminderText } from '@plannotator/shared/config'
import { INBOX_REMINDER_MAX_CHARS, INBOX_RULES_LEAD } from '@plannotator/shared/inbox/connection'
import { resolveInboxReminderCustom, resolveInboxReminderRules } from './enabled'
import { inboxReminderEnvValue } from './inbox'
import { inboxReminderFor, inboxReminderText } from './inbox-contract'

const TOOL = 'mcp__plugin_plannotator_tools__plannotator_inbox'
const RULES = 'Only message me when you are blocked or done.\nKeep messages under 10 lines.'

function modReminder(config: unknown): string {
  const text = JSON.stringify(config)
  return inboxReminderFor(resolveInboxReminderCustom(text), TOOL, { rules: resolveInboxReminderRules(text) })
}

describe('rules follow the reminder', () => {
  test('after the built-in text, under the lead line, for every agent', () => {
    const config = { prompts: { inbox: { rules: RULES } } }
    expect(modReminder(config)).toBe(`${inboxReminderText(TOOL)}\n\n${INBOX_RULES_LEAD}\n${RULES}`)
    for (const host of ['pi', 'opencode'] as const) {
      expect(resolveInboxReminderText(config, host)).toBe(`${inboxReminderText()}\n\n${INBOX_RULES_LEAD}\n${RULES}`)
    }
    expect(inboxReminderEnvValue(true, TOOL, null, RULES)).toBe(modReminder(config))
  })

  test('after a replaced reminder too, and the mod agrees with packages/shared', () => {
    const config = { prompts: { inbox: { reminder: 'Use plannotator_inbox for decisions.', rules: RULES } } }
    expect(modReminder(config)).toBe(`Use ${TOOL} for decisions.\n\n${INBOX_RULES_LEAD}\n${RULES}`)
    expect(modReminder(config)).toBe(resolveInboxReminderText(config, 'claude-code', { toolName: TOOL }))
  })

  test("an agent's own rules win over the shared ones, for that agent only", () => {
    const config = { prompts: { inbox: { rules: RULES, runtimes: { 'claude-code': { rules: 'Never send from reviewer sessions.' } } } } }
    expect(modReminder(config).endsWith(`${INBOX_RULES_LEAD}\nNever send from reviewer sessions.`)).toBe(true)
    expect(modReminder(config)).not.toContain('blocked or done')
    expect(resolveInboxReminderText(config, 'pi').endsWith(RULES)).toBe(true)
  })

  test('no rules (Back to default deletes the key): the reminder byte for byte', () => {
    for (const config of [{}, { prompts: { inbox: { rules: '   ' } } }, { prompts: { inbox: { runtimes: { pi: { rules: 'Pi only.' } } } } }]) {
      expect(modReminder(config)).toBe(inboxReminderText(TOOL))
    }
  })

  test('rules that would pass the cap are left out whole, never cut', () => {
    const long = 'x'.repeat(INBOX_REMINDER_MAX_CHARS)
    expect(modReminder({ prompts: { inbox: { rules: long } } })).toBe(inboxReminderText(TOOL))
    const fits = modReminder({ prompts: { inbox: { rules: 'y'.repeat(INBOX_REMINDER_MAX_CHARS - inboxReminderText(TOOL).length - INBOX_RULES_LEAD.length - 3) } } })
    expect(fits.length).toBe(INBOX_REMINDER_MAX_CHARS)
  })
})
